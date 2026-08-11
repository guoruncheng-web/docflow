import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../auth/auth.service';
import { AuthResponseDto } from '../auth/dto/auth.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';

// A day, reaped by a daily job — so a workspace lives between 24 and 48 hours
// rather than exactly 24. The Hobby plan allows one cron run a day, and a
// promise of "deleted after a day" that is kept within a day of that is worth
// more than a schedule the platform will not run.
const SANDBOX_TTL_HOURS = 24;

/**
 * Ceiling on live sandboxes.
 *
 * Each one can spend model credit and store files the moment a visitor uses
 * it, so an unauthenticated endpoint that provisions both needs a limit that
 * is not "whatever the internet feels like today".
 */
const MAX_LIVE_SANDBOXES = 120;

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly blob: BlobService,
  ) {}

  /**
   * Mints a private workspace and signs the visitor into it.
   *
   * It starts empty. The first act is choosing a document and watching it be
   * read, and a workspace pre-filled with finished records would hide the only
   * part worth showing.
   */
  async createSandbox(): Promise<AuthResponseDto> {
    await this.reap();

    const id = randomUUID();

    const user = await this.prisma.user.create({
      data: {
        email: `demo-${id}@sandbox.docflow.app`,
        name: 'Alex Moore',
        role: 'approver',
        passwordHash: await bcrypt.hash(randomUUID(), 10),
        organization: {
          create: {
            name: 'Riverbend Operations',
            isDemo: true,
            expiresAt: new Date(Date.now() + SANDBOX_TTL_HOURS * 3_600_000),
          },
        },
      },
      include: { organization: true },
    });

    await this.prisma.auditEvent.create({
      data: {
        organizationId: user.organizationId,
        subjectType: 'organization',
        subjectId: user.organizationId,
        action: 'workspace.created',
        actor: 'system',
        detail: { expiresInHours: SANDBOX_TTL_HOURS },
      },
    });

    return this.auth.issueToken(user);
  }

  /**
   * Deletes expired sandboxes, their documents and their stored files.
   *
   * The files matter as much as the rows: a demo that keeps every uploaded
   * document forever is a demo that is quietly accumulating other people's
   * paperwork.
   */
  async reap(): Promise<{ organizations: number; blobs: number }> {
    const expired = await this.prisma.organization.findMany({
      where: { isDemo: true, expiresAt: { lt: new Date() } },
      select: { id: true, documents: { select: { blobUrl: true } } },
      take: 20,
    });

    if (expired.length === 0) {
      await this.enforceCeiling();
      return { organizations: 0, blobs: 0 };
    }

    const blobUrls = expired.flatMap((organization) => organization.documents.map((document) => document.blobUrl));
    await this.blob.remove(blobUrls);

    // The rows go after the files: a failed delete then leaves an orphaned
    // blob whose organization still exists to be retried, rather than a blob
    // nothing in the database remembers.
    const { count } = await this.prisma.organization.deleteMany({
      where: { id: { in: expired.map((organization) => organization.id) } },
    });

    this.logger.log(`Reaped ${count} expired sandbox(es) and ${blobUrls.length} file(s)`);
    await this.enforceCeiling();

    return { organizations: count, blobs: blobUrls.length };
  }

  /** Drops the oldest sandboxes once there are more live than the cap allows. */
  private async enforceCeiling(): Promise<void> {
    const live = await this.prisma.organization.count({ where: { isDemo: true } });
    if (live <= MAX_LIVE_SANDBOXES) return;

    const oldest = await this.prisma.organization.findMany({
      where: { isDemo: true },
      orderBy: { createdAt: 'asc' },
      take: live - MAX_LIVE_SANDBOXES,
      select: { id: true, documents: { select: { blobUrl: true } } },
    });

    await this.blob.remove(oldest.flatMap((organization) => organization.documents.map((d) => d.blobUrl)));
    await this.prisma.organization.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });

    this.logger.warn(`Sandbox ceiling reached; removed ${oldest.length} of the oldest workspaces`);
  }
}
