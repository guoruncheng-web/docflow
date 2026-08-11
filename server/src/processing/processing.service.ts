import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { BlobService } from '../storage/blob.service';
import { DocumentsService } from '../documents/documents.service';
import { TemplatesService } from '../templates/templates.service';
import { INVOICE_FIELD_POLICIES, INVOICE_TEMPLATE_VERSION, type InvoiceRecord } from '../templates/invoice.template';
import { extractInvoice, type ProposedField } from './extraction';
import { DocumentReadError, PdfTextLayerAdapter } from './pdf-text';
import { validateInvoice, type Finding } from './rules';

/**
 * One document, from stored bytes to a reviewable record.
 *
 * The order matters and is not arbitrary. Text and geometry come first, because
 * everything downstream — including whether a model's claim can be believed —
 * is checked against them. The model proposes. Deterministic rules judge. Only
 * then does a record exist, at version 1, with findings attached and nothing
 * approved.
 *
 * Every attempt, cost and failure is persisted as it happens rather than
 * summarised at the end: this runs in a function that may be killed mid-flight,
 * and a run that vanishes without trace is indistinguishable from one that
 * never started.
 */

export type ProcessEvents = {
  onStage?: (stage: string, detail?: Record<string, unknown>) => void;
  onToken?: (token: string) => void;
  onAttempt?: (attempt: { attempt: number; outcome: string; error?: string; delayMs?: number }) => void;
};

@Injectable()
export class ProcessingService {
  private readonly logger = new Logger(ProcessingService.name);
  private readonly ocr = new PdfTextLayerAdapter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly templates: TemplatesService,
    private readonly blob: BlobService,
    private readonly llm: LlmService,
  ) {}

  async process(organizationId: string, documentId: string, events: ProcessEvents = {}) {
    const document = await this.documents.get(organizationId, documentId);
    const template = await this.templates.invoice();

    await this.prisma.document.update({ where: { id: document.id }, data: { status: 'processing' } });

    const run = await this.prisma.processingRun.create({
      data: {
        documentId: document.id,
        templateId: template.id,
        templateVersion: INVOICE_TEMPLATE_VERSION,
        promptVersion: template.promptVersion,
        ocrProvider: this.ocr.name,
        status: 'running',
      },
    });

    const startedAt = Date.now();

    try {
      events.onStage?.('reading', { provider: this.ocr.name });

      const bytes = await this.fetchBytes(document.blobKey);
      const extracted = await this.ocr.extract(bytes);

      await this.prisma.$transaction([
        this.prisma.documentPage.deleteMany({ where: { documentId: document.id } }),
        this.prisma.documentPage.createMany({
          data: extracted.pages.map((page) => ({
            documentId: document.id,
            pageNumber: page.pageNumber,
            width: page.width,
            height: page.height,
            text: page.text,
          })),
        }),
        this.prisma.document.update({ where: { id: document.id }, data: { pageCount: extracted.pages.length } }),
      ]);

      events.onStage?.('extracting', {
        pages: extracted.pages.length,
        characters: extracted.pages.reduce((total, page) => total + page.text.length, 0),
      });

      const result = await extractInvoice({
        document: extracted,
        onToken: events.onToken,
        onAttempt: events.onAttempt,
        complete: async ({ messages, onToken }) => {
          const call = await this.llm.complete({ messages, onToken });

          await this.prisma.modelCall.create({
            data: {
              runId: run.id,
              organizationId,
              purpose: 'extraction',
              attempt: 1,
              outcome: 'ok',
              model: call.model,
              promptVersion: template.promptVersion,
              inputTokens: call.inputTokens,
              outputTokens: call.outputTokens,
              costMicros: call.costMicros,
              latencyMs: call.latencyMs,
            },
          });

          return call;
        },
      });

      events.onStage?.('validating');

      const findings = await this.validate(organizationId, document.id, document.sha256, result.record, result.confidences);
      const totals = result.calls.reduce(
        (sum, call) => ({
          inputTokens: sum.inputTokens + call.inputTokens,
          outputTokens: sum.outputTokens + call.outputTokens,
          costMicros: sum.costMicros + call.costMicros,
        }),
        { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      );

      const record = await this.persist({
        organizationId,
        documentId: document.id,
        runId: run.id,
        proposals: result.proposals,
        value: result.record,
        findings,
        totals,
        attempts: result.attempts.length,
        latencyMs: Date.now() - startedAt,
      });

      return {
        recordId: record.id,
        runId: run.id,
        record: result.record,
        findings,
        attempts: result.attempts,
        costMicros: totals.costMicros,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const readable = error instanceof DocumentReadError;

      await this.prisma.$transaction([
        this.prisma.processingRun.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            error: (error as Error).message.slice(0, 500),
            latencyMs: Date.now() - startedAt,
            finishedAt: new Date(),
          },
        }),
        this.prisma.document.update({ where: { id: document.id }, data: { status: 'processing_failed' } }),
        this.prisma.auditEvent.create({
          data: {
            organizationId,
            subjectType: 'document',
            subjectId: document.id,
            action: 'processing.failed',
            actor: 'system',
            detail: { reason: readable ? (error as DocumentReadError).reason : 'error' },
          },
        }),
      ]);

      throw error;
    }
  }

  private async fetchBytes(blobKey: string): Promise<Uint8Array> {
    const url = await this.blob.signedReadUrl(blobKey);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`The stored document could not be read back (${response.status}).`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  private async validate(
    organizationId: string,
    documentId: string,
    sha256: string,
    record: InvoiceRecord,
    confidences: Record<string, number>,
  ): Promise<Finding[]> {
    const duplicateOfDocumentId = await this.documents.duplicateOf(organizationId, documentId, sha256);

    const others = await this.prisma.record.findMany({
      where: { organizationId, documentId: { not: documentId } },
      select: { id: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { data: true } } },
    });

    const siblings = others
      .map((other) => {
        const data = other.versions[0]?.data as unknown as InvoiceRecord | undefined;
        return data
          ? {
              id: other.id,
              vendorName: data.vendorName ?? '',
              invoiceNumber: data.invoiceNumber ?? '',
              totalMinor: data.totalMinor ?? 0,
            }
          : null;
      })
      .filter((sibling): sibling is NonNullable<typeof sibling> => sibling !== null);

    return validateInvoice({
      record,
      confidences,
      policies: INVOICE_FIELD_POLICIES,
      siblings,
      duplicateOfDocumentId,
      today: new Date(),
    });
  }

  /**
   * Writes the run's results and the record together.
   *
   * In one transaction, because a record without its findings is a record that
   * looks clean, and that is the one state this system must never present.
   */
  private async persist(input: {
    organizationId: string;
    documentId: string;
    runId: string;
    proposals: ProposedField[];
    value: InvoiceRecord;
    findings: Finding[];
    totals: { inputTokens: number; outputTokens: number; costMicros: number };
    attempts: number;
    latencyMs: number;
  }) {
    const existing = await this.prisma.record.findUnique({ where: { documentId: input.documentId } });
    const version = (existing?.currentVersion ?? 0) + 1;

    const [record] = await this.prisma.$transaction([
      this.prisma.record.upsert({
        where: { documentId: input.documentId },
        create: {
          organizationId: input.organizationId,
          documentId: input.documentId,
          status: 'needs_review',
          currentVersion: 1,
        },
        // Re-processing supersedes the previous reading, and an approval of the
        // older one no longer applies to what is now on screen.
        update: { status: 'needs_review', currentVersion: version, approvedVersion: null },
      }),
      this.prisma.processingRun.update({
        where: { id: input.runId },
        data: {
          status: 'succeeded',
          attempts: input.attempts,
          inputTokens: input.totals.inputTokens,
          outputTokens: input.totals.outputTokens,
          costMicros: input.totals.costMicros,
          latencyMs: input.latencyMs,
          finishedAt: new Date(),
        },
      }),
      this.prisma.document.update({ where: { id: input.documentId }, data: { status: 'needs_review' } }),
    ]);

    await this.prisma.$transaction([
      this.prisma.fieldProposal.createMany({
        data: input.proposals.map((proposal) => ({
          runId: input.runId,
          fieldPath: proposal.fieldPath,
          rawValue: proposal.rawValue,
          normalizedValue: proposal.normalizedValue as object,
          confidence: proposal.confidence,
          method: proposal.method,
          pageNumber: proposal.pageNumber,
          evidenceText: proposal.evidenceText,
          // Prisma distinguishes "absent" from "JSON null"; undefined is the
          // one that leaves the column NULL rather than storing the literal.
          evidenceBox: (proposal.evidenceBox ?? undefined) as object | undefined,
        })),
      }),
      this.prisma.recordVersion.create({
        data: {
          recordId: record.id,
          version,
          data: input.value as unknown as object,
          changedBy: 'system',
          reason: 'extraction',
        },
      }),
      this.prisma.validationFinding.deleteMany({ where: { recordId: record.id } }),
      this.prisma.validationFinding.createMany({
        data: input.findings.map((finding) => ({
          recordId: record.id,
          version,
          code: finding.code,
          severity: finding.severity,
          fieldPath: finding.fieldPath,
          message: finding.message,
        })),
      }),
      this.prisma.auditEvent.create({
        data: {
          organizationId: input.organizationId,
          subjectType: 'record',
          subjectId: record.id,
          action: 'record.extracted',
          actor: 'system',
          detail: {
            version,
            findings: input.findings.length,
            errors: input.findings.filter((finding) => finding.severity === 'error').length,
            costMicros: input.totals.costMicros,
          },
        },
      }),
    ]);

    return record;
  }
}
