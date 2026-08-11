import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { TemplatesService } from '../templates/templates.service';
import { SamplesService } from './samples.service';

/**
 * Intake.
 *
 * Two things happen before a document is allowed to exist. Its bytes are
 * hashed, so the same file arriving twice is a fact the pipeline knows rather
 * than a coincidence a reviewer might notice; and it is stored under a key
 * prefixed with the tenant, so no later mistake can turn one workspace's
 * document into another's.
 *
 * Everything after this point reads from the database. The upload is the only
 * place raw bytes are handled, which keeps "can this caller see this document"
 * a single question asked in a single place.
 */

const MAX_BYTES = 6 * 1024 * 1024;
const ACCEPTED = new Set(['application/pdf']);

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly templates: TemplatesService,
    private readonly samples: SamplesService,
  ) {}

  async list(organizationId: string) {
    const documents = await this.prisma.document.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        template: { select: { key: true, name: true } },
        record: {
          select: {
            id: true,
            status: true,
            currentVersion: true,
            approvedVersion: true,
            versions: { orderBy: { version: 'desc' }, take: 1, select: { data: true } },
            findings: { where: { resolvedAt: null }, select: { severity: true } },
          },
        },
      },
    });

    return documents.map((document) => {
      const data = (document.record?.versions[0]?.data ?? null) as Record<string, unknown> | null;

      return {
        id: document.id,
        filename: document.filename,
        status: document.status,
        templateKey: document.template.key,
        pageCount: document.pageCount,
        byteSize: document.byteSize,
        createdAt: document.createdAt.toISOString(),
        recordId: document.record?.id ?? null,
        recordStatus: document.record?.status ?? null,
        vendorName: (data?.vendorName as string) ?? null,
        invoiceNumber: (data?.invoiceNumber as string) ?? null,
        totalMinor: (data?.totalMinor as number) ?? null,
        currency: (data?.currency as string) ?? null,
        openErrors: document.record?.findings.filter((finding) => finding.severity === 'error').length ?? 0,
        openWarnings: document.record?.findings.filter((finding) => finding.severity === 'warning').length ?? 0,
      };
    });
  }

  async get(organizationId: string, documentId: string) {
    // Both identifiers, always: querying by document id alone would return
    // another tenant's row and only then check it, which is one forgotten
    // check away from a leak.
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId },
      include: {
        template: true,
        pages: { orderBy: { pageNumber: 'asc' }, select: { pageNumber: true, width: true, height: true } },
        runs: {
          orderBy: { startedAt: 'desc' },
          include: { proposals: true, calls: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });

    if (!document) throw new NotFoundException('No such document in this workspace.');
    return document;
  }

  /** A short-lived link the browser can render the original from. */
  async fileUrl(organizationId: string, documentId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, organizationId },
      select: { blobKey: true },
    });

    if (!document) throw new NotFoundException('No such document in this workspace.');

    return { url: await this.blob.signedReadUrl(document.blobKey), expiresInSeconds: 300 };
  }

  async fromSample(organizationId: string, slug: string) {
    const { sample, bytes } = await this.samples.bytes(slug);
    return this.store({ organizationId, filename: sample.filename, contentType: 'application/pdf', bytes });
  }

  async fromUpload(input: {
    organizationId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }) {
    if (!ACCEPTED.has(input.contentType)) {
      throw new BadRequestException(
        `This demo reads PDFs. ${input.contentType || 'That file type'} would need an OCR provider, which the public demo deliberately does not run.`,
      );
    }

    if (input.bytes.byteLength > MAX_BYTES) {
      throw new BadRequestException(`Documents are limited to ${MAX_BYTES / 1024 / 1024} MB in the demo.`);
    }

    // Checked as well as declared: a content type is a claim by the caller, and
    // a PDF that is not a PDF should be refused at the door rather than deep
    // inside a parser.
    const header = Buffer.from(input.bytes.slice(0, 5)).toString('latin1');
    if (header !== '%PDF-') {
      throw new BadRequestException('That file is not a PDF, whatever its name or content type says.');
    }

    return this.store(input);
  }

  private async store(input: {
    organizationId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }) {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const template = await this.templates.invoice();

    const { key, url } = await this.blob.upload({
      organizationId: input.organizationId,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
    });

    const document = await this.prisma.document.create({
      data: {
        organizationId: input.organizationId,
        templateId: template.id,
        filename: input.filename,
        mimeType: input.contentType,
        byteSize: input.bytes.byteLength,
        sha256,
        blobKey: key,
        blobUrl: url,
        status: 'uploaded',
      },
    });

    await this.prisma.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        subjectType: 'document',
        subjectId: document.id,
        action: 'document.received',
        actor: 'user',
        detail: { filename: input.filename, byteSize: input.bytes.byteLength, sha256 },
      },
    });

    return document;
  }

  /** Any earlier document in this workspace with identical bytes. */
  async duplicateOf(organizationId: string, documentId: string, sha256: string): Promise<string | null> {
    const earlier = await this.prisma.document.findFirst({
      where: { organizationId, sha256, id: { not: documentId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    return earlier?.id ?? null;
  }
}
