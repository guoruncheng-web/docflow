import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { backoffDelay, DEFAULT_RETRY } from '../llm/retry';
import type { InvoiceRecord } from '../templates/invoice.template';
import { DestinationError, MockAccountingAdapter, type SyncFault } from './mock-accounting.adapter';

/**
 * Delivering an approved record to the destination.
 *
 * The hard case is not failure, which is obvious and retryable. It is the
 * request that succeeded on the other side and then failed on the way back:
 * the local state says "not sent", the destination says "here is your bill",
 * and a naive retry books it twice. Everything here is arranged around that.
 *
 * The idempotency key is derived from what was approved — organization,
 * record, approved version, destination — and never from the moment of
 * sending. Two attempts for the same approval therefore carry the same key,
 * and the destination answers the second one with the bill the first one
 * created. A key containing a timestamp or a random value would look correct in
 * every test that does not model a lost response, and would be exactly wrong.
 *
 * Retries are bounded and recorded per attempt. Nothing here assumes the
 * process survives the response: each attempt persists its own outcome before
 * returning, so a function that is killed mid-flight resumes from the database
 * rather than from a variable that no longer exists.
 */

export type SyncOutcome = {
  jobId: string;
  status: 'synced' | 'failed' | 'pending';
  externalId: string | null;
  attempts: Array<{ attempt: number; outcome: string; error?: string; delayMs?: number }>;
  deduplicated: boolean;
  message: string;
};

const MAX_ATTEMPTS = 3;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly destination: MockAccountingAdapter,
  ) {}

  /**
   * The key that makes a retry safe.
   *
   * `approvedVersion` is in it deliberately: approving, editing and approving
   * again is a different business decision that deserves its own delivery,
   * while retrying one approval must not.
   */
  static idempotencyKey(input: {
    organizationId: string;
    recordId: string;
    approvedVersion: number;
    destination: string;
  }): string {
    return `record-sync:${input.organizationId}:${input.recordId}:${input.approvedVersion}:${input.destination}`;
  }

  async deliver(input: {
    organizationId: string;
    recordId: string;
    approvedVersion: number;
    record: InvoiceRecord;
    fault: SyncFault;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<SyncOutcome> {
    const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const key = SyncService.idempotencyKey({
      organizationId: input.organizationId,
      recordId: input.recordId,
      approvedVersion: input.approvedVersion,
      destination: this.destination.name,
    });

    const job = await this.prisma.syncJob.upsert({
      where: { idempotencyKey: key },
      create: {
        organizationId: input.organizationId,
        recordId: input.recordId,
        destination: this.destination.name,
        idempotencyKey: key,
        status: 'pending',
        requestBody: this.destination.buildPayload(input.record) as object,
      },
      update: {},
    });

    // Already delivered: say so and touch nothing. A second "Sync now" click
    // must not become a second bill either.
    if (job.status === 'synced') {
      return {
        jobId: job.id,
        status: 'synced',
        externalId: job.externalId,
        attempts: [],
        deduplicated: true,
        message: `Already delivered as ${job.externalId}. Nothing was sent again.`,
      };
    }

    const attempts: SyncOutcome['attempts'] = [];

    for (let attempt = job.attempts + 1; attempt <= job.attempts + MAX_ATTEMPTS; attempt += 1) {
      const started = Date.now();

      try {
        const bill = await this.destination.createBill({
          organizationId: input.organizationId,
          idempotencyKey: key,
          record: input.record,
          fault: input.fault,
          attempt: attempt - job.attempts,
        });

        attempts.push({ attempt, outcome: bill.deduplicated ? 'ok_deduplicated' : 'ok' });

        await this.prisma.$transaction([
          this.prisma.syncAttempt.create({
            data: {
              jobId: job.id,
              attempt,
              outcome: bill.deduplicated ? 'ok_deduplicated' : 'ok',
              status: 200,
              latencyMs: Date.now() - started,
            },
          }),
          this.prisma.syncJob.update({
            where: { id: job.id },
            data: {
              status: 'synced',
              attempts: attempt,
              externalId: bill.externalId,
              responseBody: bill as unknown as object,
              lastError: null,
            },
          }),
          this.prisma.record.update({
            where: { id: input.recordId },
            data: { status: 'synced' },
          }),
          this.prisma.auditEvent.create({
            data: {
              organizationId: input.organizationId,
              subjectType: 'record',
              subjectId: input.recordId,
              action: bill.deduplicated ? 'sync.deduplicated' : 'sync.succeeded',
              actor: 'system',
              detail: { externalId: bill.externalId, attempt, destination: this.destination.name },
            },
          }),
        ]);

        return {
          jobId: job.id,
          status: 'synced',
          externalId: bill.externalId,
          attempts,
          deduplicated: bill.deduplicated,
          message: bill.deduplicated
            ? `The destination already had this bill as ${bill.externalId} and returned it instead of creating a second one.`
            : `Created ${bill.externalId} at the destination.`,
        };
      } catch (error) {
        const failure = error instanceof DestinationError ? error : null;
        const kind = failure?.kind ?? 'unknown';
        const last = attempt === job.attempts + MAX_ATTEMPTS;
        const retryable = failure?.retryable ?? false;

        const delayMs =
          retryable && !last
            ? backoffDelay(attempt - job.attempts, DEFAULT_RETRY, failure?.retryAfterMs)
            : undefined;

        attempts.push({ attempt, outcome: kind, error: (error as Error).message, delayMs });

        await this.prisma.$transaction([
          this.prisma.syncAttempt.create({
            data: {
              jobId: job.id,
              attempt,
              outcome: kind,
              status: failure?.status ?? null,
              error: (error as Error).message.slice(0, 500),
              delayMs: delayMs ?? null,
              latencyMs: Date.now() - started,
            },
          }),
          this.prisma.syncJob.update({
            where: { id: job.id },
            data: {
              attempts: attempt,
              lastError: (error as Error).message.slice(0, 500),
              status: retryable && !last ? 'pending' : 'failed',
            },
          }),
        ]);

        if (!retryable || last) {
          await this.prisma.$transaction([
            this.prisma.record.update({ where: { id: input.recordId }, data: { status: 'sync_failed' } }),
            this.prisma.auditEvent.create({
              data: {
                organizationId: input.organizationId,
                subjectType: 'record',
                subjectId: input.recordId,
                action: 'sync.failed',
                actor: 'system',
                detail: { attempt, reason: kind, message: (error as Error).message.slice(0, 300) },
              },
            }),
          ]);

          return {
            jobId: job.id,
            status: 'failed',
            externalId: null,
            attempts,
            deduplicated: false,
            message: retryable
              ? `Gave up after ${attempt} attempts. The last error was: ${(error as Error).message}`
              : `The destination refused this record, and repeating the request would be refused identically. ${(error as Error).message}`,
          };
        }

        await sleep(delayMs ?? 0);
      }
    }

    return {
      jobId: job.id,
      status: 'pending',
      externalId: null,
      attempts,
      deduplicated: false,
      message: 'Still pending.',
    };
  }
}
