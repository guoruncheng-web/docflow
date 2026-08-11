import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { InvoiceRecord } from '../templates/invoice.template';
import { SUPPORTED_CURRENCIES } from '../templates/invoice.template';

/**
 * A stand-in accounting system that behaves like a remote one.
 *
 * The point of a mock destination is not to make the demo succeed; it is to
 * make the interesting failures reproducible. A success button proves nothing,
 * because every integration works when the other side answers immediately and
 * correctly. This one rejects payloads it cannot map, rate-limits, times out,
 * fails, and — the case that actually costs people money — succeeds while
 * appearing to fail, so the retry has to be the one that does not create a
 * second bill.
 *
 * The remote state is a table rather than a variable: on Vercel the next
 * request runs in a different container, and an in-memory ledger would forget
 * everything between the send and the retry, which is precisely the window
 * being demonstrated.
 */

export type SyncFault = 'none' | 'rate_limit' | 'server_error' | 'timeout' | 'lost_response';

export const SYNC_FAULTS: Array<{ value: SyncFault; label: string }> = [
  { value: 'none', label: 'No fault' },
  { value: 'rate_limit', label: 'Rate-limit the first attempt' },
  { value: 'server_error', label: 'Fail the first attempt with a 500' },
  { value: 'timeout', label: 'Time out the first attempt' },
  { value: 'lost_response', label: 'Succeed remotely, lose the response' },
];

export class DestinationError extends Error {
  constructor(
    readonly kind: 'rate_limited' | 'server_error' | 'timeout' | 'mapping' | 'lost_response',
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DestinationError';
  }

  get retryable(): boolean {
    return this.kind !== 'mapping';
  }
}

export type DestinationBill = {
  externalId: string;
  vendorName: string;
  invoiceNumber: string;
  currency: string;
  totalMinor: number;
  createdAt: string;
  /** True when this call matched an existing bill instead of creating one. */
  deduplicated: boolean;
};

@Injectable()
export class MockAccountingAdapter {
  readonly name = 'mock-accounting';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The payload the destination would receive.
   *
   * Shown to the approver before they approve, because "approve this record"
   * and "approve what will be sent" are different questions when a mapping
   * sits between them, and only the second one is the decision being made.
   */
  buildPayload(record: InvoiceRecord): Record<string, unknown> {
    return {
      vendor: { name: record.vendorName },
      reference: record.invoiceNumber,
      issuedOn: record.invoiceDate,
      dueOn: record.dueDate,
      purchaseOrder: record.purchaseOrder,
      currency: record.currency,
      lines: record.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unitPriceMinor / 100,
        lineAmount: line.amountMinor / 100,
      })),
      subtotal: record.subtotalMinor / 100,
      tax: record.taxMinor / 100,
      total: record.totalMinor / 100,
    };
  }

  /**
   * Checks what the destination would reject before anything is sent.
   *
   * A mapping failure is not worth retrying — the same payload will be refused
   * identically — so finding it here turns a queue of doomed attempts into one
   * actionable message.
   */
  validateMapping(record: InvoiceRecord): string[] {
    const problems: string[] = [];

    if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(record.currency)) {
      problems.push(`the destination ledger has no account in ${record.currency}`);
    }
    if (!record.vendorName?.trim()) problems.push('a bill needs a vendor');
    if (!record.invoiceNumber?.trim()) problems.push('a bill needs a reference');
    if (record.totalMinor <= 0) problems.push('a bill total must be positive');

    return problems;
  }

  /**
   * Creates a bill, or returns the one this idempotency key already created.
   *
   * The deduplication happens on the destination's side of the boundary,
   * exactly as a real provider's does, so a retry after an unseen success is
   * answered with the original bill rather than a second one.
   */
  async createBill(input: {
    organizationId: string;
    idempotencyKey: string;
    record: InvoiceRecord;
    fault: SyncFault;
    attempt: number;
  }): Promise<DestinationBill> {
    const problems = this.validateMapping(input.record);
    if (problems.length > 0) {
      throw new DestinationError('mapping', `The destination rejected this bill: ${problems.join('; ')}.`, 422);
    }

    // Faults apply to the first attempt only, so the demo shows a recovery
    // rather than an endless failure.
    if (input.attempt === 1) {
      switch (input.fault) {
        case 'rate_limit':
          throw new DestinationError('rate_limited', 'The destination is rate limiting this connection.', 429, 900);
        case 'server_error':
          throw new DestinationError('server_error', 'The destination returned 500 Internal Server Error.', 500);
        case 'timeout':
          throw new DestinationError('timeout', 'The destination did not respond within the timeout.');
        case 'lost_response':
          // Written first, then the failure: from here the bill exists and the
          // caller has no idea. Everything about idempotency exists for this.
          await this.persist(input.organizationId, input.idempotencyKey, input.record);
          throw new DestinationError(
            'lost_response',
            'The connection dropped after the request was sent. Whether the destination created the bill is unknown from here.',
          );
        default:
          break;
      }
    }

    return this.persist(input.organizationId, input.idempotencyKey, input.record);
  }

  private async persist(
    organizationId: string,
    idempotencyKey: string,
    record: InvoiceRecord,
  ): Promise<DestinationBill> {
    const existing = await this.prisma.destinationBill.findUnique({ where: { idempotencyKey } });

    if (existing) {
      return {
        externalId: existing.externalId,
        vendorName: existing.vendorName,
        invoiceNumber: existing.invoiceNumber,
        currency: existing.currency,
        totalMinor: existing.totalMinor,
        createdAt: existing.createdAt.toISOString(),
        deduplicated: true,
      };
    }

    const created = await this.prisma.destinationBill.create({
      data: {
        organizationId,
        idempotencyKey,
        externalId: `BILL-${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 900 + 100)}`,
        vendorName: record.vendorName,
        invoiceNumber: record.invoiceNumber,
        currency: record.currency,
        totalMinor: record.totalMinor,
      },
    });

    return {
      externalId: created.externalId,
      vendorName: created.vendorName,
      invoiceNumber: created.invoiceNumber,
      currency: created.currency,
      totalMinor: created.totalMinor,
      createdAt: created.createdAt.toISOString(),
      deduplicated: false,
    };
  }

  /** What the destination believes it holds — the demo shows this side too. */
  async listBills(organizationId: string): Promise<DestinationBill[]> {
    const bills = await this.prisma.destinationBill.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return bills.map((bill) => ({
      externalId: bill.externalId,
      vendorName: bill.vendorName,
      invoiceNumber: bill.invoiceNumber,
      currency: bill.currency,
      totalMinor: bill.totalMinor,
      createdAt: bill.createdAt.toISOString(),
      deduplicated: false,
    }));
  }
}
