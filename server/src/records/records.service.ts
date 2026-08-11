import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from '../documents/documents.service';
import { MockAccountingAdapter, type SyncFault } from '../integrations/mock-accounting.adapter';
import { SyncService } from '../integrations/sync.service';
import {
  INVOICE_APPROVAL_POLICY,
  INVOICE_FIELD_POLICIES,
  INVOICE_TEMPLATE_VERSION,
  type InvoiceRecord,
} from '../templates/invoice.template';
import { validateInvoice } from '../processing/rules';

/**
 * The reviewed record: what a person edits, and what approval means.
 *
 * The rules enforced here are the reason the product is not a chat window over
 * a PDF. An edit produces a new immutable version and cancels any approval of
 * the old one. An approval names the version and template it approved.
 * Delivery is only ever offered for a version that was actually approved.
 *
 * All of it is enforced server-side. A disabled button is a courtesy to the
 * person using the screen, not a control: the API is the boundary that decides
 * whether an unreviewed number can reach an accounting system.
 */

/** Fields a reviewer may correct. Everything else is derived or historical. */
const EDITABLE = new Set([
  'vendorName',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'purchaseOrder',
  'currency',
  'subtotalMinor',
  'taxMinor',
  'totalMinor',
]);

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly destination: MockAccountingAdapter,
    private readonly sync: SyncService,
  ) {}

  async get(organizationId: string, recordId: string) {
    const record = await this.prisma.record.findFirst({
      where: { id: recordId, organizationId },
      include: {
        document: {
          include: {
            pages: { orderBy: { pageNumber: 'asc' } },
            runs: {
              orderBy: { startedAt: 'desc' },
              take: 1,
              include: { proposals: true, calls: { orderBy: { createdAt: 'asc' } } },
            },
          },
        },
        versions: { orderBy: { version: 'desc' } },
        findings: { orderBy: [{ severity: 'asc' }, { code: 'asc' }] },
        approvals: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
        syncJobs: { orderBy: { createdAt: 'desc' }, include: { attemptLog: { orderBy: { attempt: 'asc' } } } },
      },
    });

    if (!record) throw new NotFoundException('No such record in this workspace.');

    const current = record.versions.find((version) => version.version === record.currentVersion);
    const value = (current?.data ?? {}) as unknown as InvoiceRecord;
    const run = record.document.runs[0];

    return {
      id: record.id,
      status: record.status,
      currentVersion: record.currentVersion,
      approvedVersion: record.approvedVersion,
      document: {
        id: record.document.id,
        filename: record.document.filename,
        pageCount: record.document.pageCount,
        pages: record.document.pages.map((page) => ({
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
        })),
      },
      fields: INVOICE_FIELD_POLICIES.map((policy) => {
        const proposal = run?.proposals.find((candidate) => candidate.fieldPath === policy.path);

        return {
          path: policy.path,
          label: policy.label,
          kind: policy.kind,
          required: policy.required,
          reviewBelow: policy.reviewBelow,
          value: (value as unknown as Record<string, unknown>)[policy.path] ?? null,
          confidence: proposal?.confidence ?? null,
          method: proposal?.method ?? null,
          evidence: proposal?.evidenceText ?? null,
          evidencePage: proposal?.pageNumber ?? null,
          evidenceBox: (proposal?.evidenceBox as number[] | null) ?? null,
          // True when the stored value is no longer what the model proposed,
          // which is the honest way to show "a person changed this".
          edited: proposal ? String(proposal.rawValue) !== String((value as unknown as Record<string, unknown>)[policy.path]) : false,
        };
      }),
      lines: value.lines ?? [],
      findings: record.findings.map((finding) => ({
        id: finding.id,
        code: finding.code,
        severity: finding.severity,
        fieldPath: finding.fieldPath,
        message: finding.message,
        resolvedAt: finding.resolvedAt?.toISOString() ?? null,
        resolution: finding.resolution,
      })),
      approvals: record.approvals.map((approval) => ({
        decision: approval.decision,
        recordVersion: approval.recordVersion,
        by: approval.user.name,
        note: approval.note,
        at: approval.createdAt.toISOString(),
      })),
      versions: record.versions.map((version) => ({
        version: version.version,
        reason: version.reason,
        changedBy: version.changedBy,
        at: version.createdAt.toISOString(),
      })),
      syncJobs: record.syncJobs.map((job) => ({
        id: job.id,
        destination: job.destination,
        status: job.status,
        idempotencyKey: job.idempotencyKey,
        externalId: job.externalId,
        attempts: job.attemptLog.map((attempt) => ({
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          status: attempt.status,
          error: attempt.error,
          delayMs: attempt.delayMs,
          latencyMs: attempt.latencyMs,
          at: attempt.createdAt.toISOString(),
        })),
        requestBody: job.requestBody,
        responseBody: job.responseBody,
      })),
      destinationPayload: this.destination.buildPayload(value),
      mappingProblems: this.destination.validateMapping(value),
      approvalBlockers: this.blockers(record.findings),
      usage: run
        ? {
            costMicros: run.costMicros,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            latencyMs: run.latencyMs,
            attempts: run.attempts,
            promptVersion: run.promptVersion,
            calls: run.calls.map((call) => ({
              purpose: call.purpose,
              outcome: call.outcome,
              model: call.model,
              inputTokens: call.inputTokens,
              outputTokens: call.outputTokens,
              costMicros: call.costMicros,
              latencyMs: call.latencyMs,
            })),
          }
        : null,
    };
  }

  /**
   * Applies a correction as a new version.
   *
   * The old version is not overwritten: somebody approved it, or might have,
   * and "what did this say when it was approved" has to remain answerable.
   */
  async updateFields(
    organizationId: string,
    recordId: string,
    changes: Record<string, unknown>,
    actor: string,
  ) {
    const record = await this.load(organizationId, recordId);

    if (record.status === 'synced') {
      throw new ConflictException('This record has already been delivered; editing it now would not change the bill.');
    }

    const unknownFields = Object.keys(changes).filter((path) => !EDITABLE.has(path));
    if (unknownFields.length > 0) {
      throw new BadRequestException(`Not editable: ${unknownFields.join(', ')}.`);
    }

    const current = await this.currentValue(record.id, record.currentVersion);
    const next = { ...current, ...this.coerce(changes) } as InvoiceRecord;
    const version = record.currentVersion + 1;

    const findings = await this.revalidate(organizationId, record.documentId, next);

    await this.prisma.$transaction([
      this.prisma.recordVersion.create({
        data: { recordId: record.id, version, data: next as unknown as object, changedBy: actor, reason: 'reviewer edit' },
      }),
      this.prisma.record.update({
        where: { id: record.id },
        data: {
          currentVersion: version,
          // The approval belonged to the numbers that just changed.
          approvedVersion: INVOICE_APPROVAL_POLICY.invalidateOnEdit ? null : record.approvedVersion,
          status: 'needs_review',
        },
      }),
      this.prisma.validationFinding.deleteMany({ where: { recordId: record.id } }),
      this.prisma.validationFinding.createMany({
        data: findings.map((finding) => ({
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
          organizationId,
          subjectType: 'record',
          subjectId: record.id,
          action: 'record.edited',
          actor,
          detail: { version, fields: Object.keys(changes), invalidatedApproval: record.approvedVersion !== null },
        },
      }),
    ]);

    return this.get(organizationId, recordId);
  }

  /** Acknowledging a warning, or recording why a blocker is acceptable. */
  async resolveFinding(organizationId: string, recordId: string, findingId: string, resolution: string, actor: string) {
    const record = await this.load(organizationId, recordId);

    const finding = await this.prisma.validationFinding.findFirst({ where: { id: findingId, recordId: record.id } });
    if (!finding) throw new NotFoundException('No such finding on this record.');

    if (finding.severity === 'error' && !resolution.trim()) {
      // A blocking finding can be overridden, but not silently: somebody's
      // name and reason go next to it, because that is the artefact an audit
      // actually asks for.
      throw new BadRequestException('Overriding a blocking finding requires a reason.');
    }

    await this.prisma.$transaction([
      this.prisma.validationFinding.update({
        where: { id: finding.id },
        data: { resolvedAt: new Date(), resolution: resolution.trim() || 'Acknowledged' },
      }),
      this.prisma.auditEvent.create({
        data: {
          organizationId,
          subjectType: 'record',
          subjectId: record.id,
          action: 'finding.resolved',
          actor,
          detail: { code: finding.code, severity: finding.severity, resolution: resolution.trim() || 'Acknowledged' },
        },
      }),
    ]);

    return this.get(organizationId, recordId);
  }

  async approve(organizationId: string, recordId: string, userId: string, note: string | undefined, actor: string) {
    const record = await this.load(organizationId, recordId);
    const findings = await this.prisma.validationFinding.findMany({ where: { recordId: record.id } });
    const blockers = this.blockers(findings);

    if (blockers.length > 0) {
      throw new ConflictException(
        `This record cannot be approved yet: ${blockers.join(' ')} Resolve them, or correct the record.`,
      );
    }

    const value = await this.currentValue(record.id, record.currentVersion);
    const version = record.currentVersion;

    // The approval and the intent to deliver are written together. If the
    // process dies immediately afterwards, the system knows both that this was
    // approved and that it still owes a delivery — the pair is the whole point
    // of an outbox.
    await this.prisma.$transaction([
      this.prisma.approval.create({
        data: {
          recordId: record.id,
          userId,
          decision: 'approved',
          recordVersion: version,
          templateVersion: INVOICE_TEMPLATE_VERSION,
          note: note?.slice(0, 500) ?? null,
        },
      }),
      this.prisma.record.update({
        where: { id: record.id },
        data: { status: 'approved', approvedVersion: version },
      }),
      this.prisma.outboxEvent.create({
        data: {
          organizationId,
          type: 'record.approved',
          payload: { recordId: record.id, approvedVersion: version, destination: this.destination.name },
        },
      }),
      this.prisma.auditEvent.create({
        data: {
          organizationId,
          subjectType: 'record',
          subjectId: record.id,
          action: 'record.approved',
          actor,
          detail: { version, templateVersion: INVOICE_TEMPLATE_VERSION, total: value.totalMinor, currency: value.currency },
        },
      }),
    ]);

    return this.get(organizationId, recordId);
  }

  async reject(organizationId: string, recordId: string, userId: string, note: string, actor: string) {
    const record = await this.load(organizationId, recordId);

    if (!note?.trim()) throw new BadRequestException('Rejecting a record requires a reason.');

    await this.prisma.$transaction([
      this.prisma.approval.create({
        data: {
          recordId: record.id,
          userId,
          decision: 'rejected',
          recordVersion: record.currentVersion,
          templateVersion: INVOICE_TEMPLATE_VERSION,
          note: note.slice(0, 500),
        },
      }),
      this.prisma.record.update({ where: { id: record.id }, data: { status: 'rejected', approvedVersion: null } }),
      this.prisma.auditEvent.create({
        data: {
          organizationId,
          subjectType: 'record',
          subjectId: record.id,
          action: 'record.rejected',
          actor,
          detail: { version: record.currentVersion, note: note.slice(0, 300) },
        },
      }),
    ]);

    return this.get(organizationId, recordId);
  }

  /**
   * Delivers what was approved.
   *
   * Deliberately not "deliver the current record": between approval and
   * delivery somebody may have edited it, and the thing with a signature next
   * to it is the approved version.
   */
  async deliver(organizationId: string, recordId: string, fault: SyncFault) {
    const record = await this.load(organizationId, recordId);

    if (record.approvedVersion === null) {
      throw new ConflictException('Only an approved record can be delivered, and this one is not approved.');
    }

    const value = await this.currentValue(record.id, record.approvedVersion);

    const outcome = await this.sync.deliver({
      organizationId,
      recordId: record.id,
      approvedVersion: record.approvedVersion,
      record: value,
      fault,
    });

    return { outcome, record: await this.get(organizationId, recordId) };
  }

  async timeline(organizationId: string, recordId: string) {
    const record = await this.load(organizationId, recordId);

    const events = await this.prisma.auditEvent.findMany({
      where: { organizationId, subjectId: { in: [record.id, record.documentId] } },
      orderBy: { createdAt: 'asc' },
    });

    return events.map((event) => ({
      action: event.action,
      actor: event.actor,
      detail: event.detail,
      at: event.createdAt.toISOString(),
    }));
  }

  /** Why approval is refused, in the words the reviewer needs. */
  private blockers(findings: Array<{ severity: string; resolvedAt: Date | null; code: string }>): string[] {
    const open = findings.filter((finding) => finding.resolvedAt === null);
    const errors = open.filter((finding) => INVOICE_APPROVAL_POLICY.blockingSeverities.includes(finding.severity as 'error'));
    const warnings = open.filter((finding) => finding.severity === 'warning');

    const blockers: string[] = [];

    if (errors.length > 0) {
      blockers.push(`${errors.length} blocking finding${errors.length === 1 ? '' : 's'} (${errors.map((f) => f.code).join(', ')}).`);
    }

    if (INVOICE_APPROVAL_POLICY.requireAcknowledgedWarnings && warnings.length > 0) {
      blockers.push(
        `${warnings.length} warning${warnings.length === 1 ? '' : 's'} awaiting acknowledgement (${warnings.map((f) => f.code).join(', ')}).`,
      );
    }

    return blockers;
  }

  private async load(organizationId: string, recordId: string) {
    const record = await this.prisma.record.findFirst({ where: { id: recordId, organizationId } });
    if (!record) throw new NotFoundException('No such record in this workspace.');
    return record;
  }

  private async currentValue(recordId: string, version: number): Promise<InvoiceRecord> {
    const stored = await this.prisma.recordVersion.findUnique({ where: { recordId_version: { recordId, version } } });
    if (!stored) throw new NotFoundException(`Version ${version} of this record no longer exists.`);
    return stored.data as unknown as InvoiceRecord;
  }

  /** Money arrives as minor units; dates and text as strings. Nothing is trusted. */
  private coerce(changes: Record<string, unknown>): Record<string, unknown> {
    const coerced: Record<string, unknown> = {};

    for (const [path, value] of Object.entries(changes)) {
      const policy = INVOICE_FIELD_POLICIES.find((candidate) => candidate.path === path);

      if (policy?.kind === 'money') {
        const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^\d-]/g, ''));
        if (!Number.isInteger(numeric)) {
          throw new BadRequestException(`${policy.label} must be a whole number of minor units.`);
        }
        coerced[path] = numeric;
      } else if (policy?.kind === 'currency') {
        coerced[path] = String(value).toUpperCase().slice(0, 3);
      } else {
        coerced[path] = value === '' ? null : value;
      }
    }

    return coerced;
  }

  private async revalidate(organizationId: string, documentId: string, next: InvoiceRecord) {
    const document = await this.prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { sha256: true },
    });

    const duplicateOfDocumentId = await this.documents.duplicateOf(organizationId, documentId, document.sha256);

    const others = await this.prisma.record.findMany({
      where: { organizationId, documentId: { not: documentId } },
      select: { id: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { data: true } } },
    });

    const siblings = others
      .map((other) => other.versions[0]?.data as unknown as InvoiceRecord | undefined)
      .filter((data): data is InvoiceRecord => Boolean(data))
      .map((data) => ({
        id: '',
        vendorName: data.vendorName ?? '',
        invoiceNumber: data.invoiceNumber ?? '',
        totalMinor: data.totalMinor ?? 0,
      }));

    // Confidence belongs to what the model proposed, not to what a person
    // typed: a corrected field is certain by definition, and re-reporting it as
    // low confidence would ask the reviewer to confirm their own work.
    const confidences = Object.fromEntries(INVOICE_FIELD_POLICIES.map((policy) => [policy.path, 1]));

    return validateInvoice({
      record: next,
      confidences,
      policies: INVOICE_FIELD_POLICIES,
      siblings,
      duplicateOfDocumentId,
      today: new Date(),
    });
  }
}
