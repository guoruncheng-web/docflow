import { SyncService } from './sync.service';
import { DestinationError, MockAccountingAdapter } from './mock-accounting.adapter';
import type { InvoiceRecord } from '../templates/invoice.template';

const RECORD: InvoiceRecord = {
  vendorName: 'Northwind Paper Co',
  invoiceNumber: 'NW-2291',
  invoiceDate: '2026-07-02',
  dueDate: '2026-08-01',
  purchaseOrder: 'PO-5512',
  currency: 'USD',
  lines: [{ description: 'A4 paper', quantity: 40, unitPriceMinor: 1150, amountMinor: 46000 }],
  subtotalMinor: 48200,
  taxMinor: 9640,
  totalMinor: 57840,
};

describe('SyncService.idempotencyKey', () => {
  const base = {
    organizationId: 'org-1',
    recordId: 'rec-1',
    approvedVersion: 3,
    destination: 'mock-accounting',
  };

  it('is stable across attempts for one approval', () => {
    expect(SyncService.idempotencyKey(base)).toBe(SyncService.idempotencyKey(base));
  });

  it('changes when a new version is approved, because that is a new decision', () => {
    expect(SyncService.idempotencyKey({ ...base, approvedVersion: 4 })).not.toBe(SyncService.idempotencyKey(base));
  });

  it('does not collide across tenants or records', () => {
    expect(SyncService.idempotencyKey({ ...base, organizationId: 'org-2' })).not.toBe(
      SyncService.idempotencyKey(base),
    );
    expect(SyncService.idempotencyKey({ ...base, recordId: 'rec-2' })).not.toBe(SyncService.idempotencyKey(base));
  });

  it('contains no timestamp or randomness, which is the whole point', () => {
    const key = SyncService.idempotencyKey(base);
    expect(key).toBe('record-sync:org-1:rec-1:3:mock-accounting');
  });
});

/**
 * The adapter is exercised against an in-memory stand-in for the bills table.
 * What matters is the contract: one idempotency key means at most one bill,
 * however many times it is called and whatever happens in between.
 */
function adapterWithMemory(): MockAccountingAdapter {
  const bills = new Map<string, { externalId: string; createdAt: Date; record: InvoiceRecord; organizationId: string }>();
  let sequence = 0;

  const prisma = {
    destinationBill: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
        const found = bills.get(where.idempotencyKey);
        return found
          ? {
              ...found.record,
              externalId: found.externalId,
              createdAt: found.createdAt,
              vendorName: found.record.vendorName,
              invoiceNumber: found.record.invoiceNumber,
              currency: found.record.currency,
              totalMinor: found.record.totalMinor,
            }
          : null;
      },
      create: async ({ data }: { data: { idempotencyKey: string; organizationId: string } }) => {
        sequence += 1;
        const created = {
          externalId: `BILL-${sequence}`,
          createdAt: new Date('2026-07-15T10:00:00Z'),
          record: RECORD,
          organizationId: data.organizationId,
        };
        bills.set(data.idempotencyKey, created);
        return {
          externalId: created.externalId,
          createdAt: created.createdAt,
          vendorName: RECORD.vendorName,
          invoiceNumber: RECORD.invoiceNumber,
          currency: RECORD.currency,
          totalMinor: RECORD.totalMinor,
        };
      },
    },
  };

  return new MockAccountingAdapter(prisma as never);
}

describe('MockAccountingAdapter', () => {
  const key = 'record-sync:org-1:rec-1:1:mock-accounting';

  it('creates a bill on the first call', async () => {
    const bill = await adapterWithMemory().createBill({
      organizationId: 'org-1',
      idempotencyKey: key,
      record: RECORD,
      fault: 'none',
      attempt: 1,
    });

    expect(bill.deduplicated).toBe(false);
    expect(bill.externalId).toMatch(/^BILL-/);
  });

  it('returns the same bill for the same key instead of creating a second', async () => {
    const adapter = adapterWithMemory();
    const call = () =>
      adapter.createBill({ organizationId: 'org-1', idempotencyKey: key, record: RECORD, fault: 'none', attempt: 2 });

    const first = await call();
    const second = await call();

    expect(second.externalId).toBe(first.externalId);
    expect(second.deduplicated).toBe(true);
  });

  it('creates the bill before losing the response, so the retry finds it', async () => {
    const adapter = adapterWithMemory();

    await expect(
      adapter.createBill({
        organizationId: 'org-1',
        idempotencyKey: key,
        record: RECORD,
        fault: 'lost_response',
        attempt: 1,
      }),
    ).rejects.toBeInstanceOf(DestinationError);

    // This is the whole scenario: the caller believes it failed, and the retry
    // must not book a second bill.
    const retry = await adapter.createBill({
      organizationId: 'org-1',
      idempotencyKey: key,
      record: RECORD,
      fault: 'lost_response',
      attempt: 2,
    });

    expect(retry.deduplicated).toBe(true);
  });

  it('refuses a currency it has no account for, and says retrying will not help', async () => {
    const error = await adapterWithMemory()
      .createBill({
        organizationId: 'org-1',
        idempotencyKey: key,
        record: { ...RECORD, currency: 'JPY' },
        fault: 'none',
        attempt: 1,
      })
      .catch((caught: DestinationError) => caught);

    expect(error).toBeInstanceOf(DestinationError);
    expect((error as DestinationError).kind).toBe('mapping');
    expect((error as DestinationError).retryable).toBe(false);
  });

  it('reports a rate limit with the delay the provider asked for', async () => {
    const error = await adapterWithMemory()
      .createBill({ organizationId: 'org-1', idempotencyKey: key, record: RECORD, fault: 'rate_limit', attempt: 1 })
      .catch((caught: DestinationError) => caught);

    expect((error as DestinationError).kind).toBe('rate_limited');
    expect((error as DestinationError).retryAfterMs).toBe(900);
    expect((error as DestinationError).retryable).toBe(true);
  });

  it('maps money to the destination in units it expects, not minor units', () => {
    const payload = adapterWithMemory().buildPayload(RECORD) as { total: number; lines: Array<{ lineAmount: number }> };

    expect(payload.total).toBe(578.4);
    expect(payload.lines[0].lineAmount).toBe(460);
  });

  it('finds mapping problems before anything is sent', () => {
    expect(adapterWithMemory().validateMapping({ ...RECORD, currency: 'JPY' })).toEqual([
      'the destination ledger has no account in JPY',
    ]);
    expect(adapterWithMemory().validateMapping(RECORD)).toEqual([]);
  });
});
