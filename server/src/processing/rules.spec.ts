import { validateInvoice, money, type RuleContext } from './rules';
import { INVOICE_FIELD_POLICIES, type InvoiceRecord } from '../templates/invoice.template';

const BASE_RECORD: InvoiceRecord = {
  vendorName: 'Northwind Paper Co',
  invoiceNumber: 'NW-2291',
  invoiceDate: '2026-07-01',
  dueDate: '2026-07-31',
  purchaseOrder: 'PO-5512',
  currency: 'USD',
  lines: [
    { description: 'A4 paper, 80gsm', quantity: 40, unitPriceMinor: 1150, amountMinor: 46000 },
    { description: 'Delivery', quantity: 1, unitPriceMinor: 2200, amountMinor: 2200 },
  ],
  subtotalMinor: 48200,
  taxMinor: 9640,
  totalMinor: 57840,
};

const CONFIDENT = Object.fromEntries(INVOICE_FIELD_POLICIES.map((policy) => [policy.path, 0.97]));

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    record: BASE_RECORD,
    confidences: CONFIDENT,
    policies: INVOICE_FIELD_POLICIES,
    siblings: [],
    duplicateOfDocumentId: null,
    today: new Date('2026-07-15T00:00:00Z'),
    ...overrides,
  };
}

const codes = (context: RuleContext) => validateInvoice(context).map((finding) => finding.code);

describe('validateInvoice', () => {
  it('passes a well-formed invoice without inventing findings', () => {
    expect(validateInvoice(context())).toEqual([]);
  });

  it('blocks when the parts do not add up to the stated total', () => {
    const record = { ...BASE_RECORD, totalMinor: 57000 };
    const findings = validateInvoice(context({ record }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'TOTAL_MISMATCH', severity: 'error', fieldPath: 'totalMinor' });
    // The message has to carry the numbers: a reviewer should not have to
    // reproduce the arithmetic to find out what disagrees with what.
    expect(findings[0].message).toContain('USD 578.40');
  });

  it('blocks when the line items disagree with the subtotal', () => {
    const record = { ...BASE_RECORD, lines: [{ ...BASE_RECORD.lines[0], amountMinor: 40000 }] };
    expect(codes(context({ record }))).toContain('CROSS_FIELD_INCONSISTENCY');
  });

  it('tolerates a single cent of per-line rounding, which is legitimate', () => {
    const record = {
      ...BASE_RECORD,
      lines: [
        { description: 'Odd unit', quantity: 3, unitPriceMinor: 333, amountMinor: 1000 },
        { description: 'Delivery', quantity: 1, unitPriceMinor: 2200, amountMinor: 2200 },
      ],
      subtotalMinor: 3200,
      taxMinor: 640,
      totalMinor: 3840,
    };

    expect(codes(context({ record }))).not.toContain('LINE_AMOUNT_MISMATCH');
  });

  it('flags a line that is off by more than rounding can explain', () => {
    const record = {
      ...BASE_RECORD,
      lines: [
        { description: 'Paper', quantity: 40, unitPriceMinor: 1150, amountMinor: 45000 },
        { description: 'Delivery', quantity: 1, unitPriceMinor: 2200, amountMinor: 2200 },
      ],
      subtotalMinor: 47200,
      taxMinor: 9440,
      totalMinor: 56640,
    };

    expect(codes(context({ record }))).toContain('LINE_AMOUNT_MISMATCH');
  });

  it('rejects a currency the destination cannot book', () => {
    expect(codes(context({ record: { ...BASE_RECORD, currency: 'JPY' } }))).toContain('UNSUPPORTED_CURRENCY');
  });

  it('rejects a required field the extractor could not find', () => {
    const findings = validateInvoice(context({ record: { ...BASE_RECORD, invoiceNumber: '' } }));
    expect(findings.map((f) => f.code)).toContain('REQUIRED_FIELD_MISSING');
  });

  it('asks for confirmation when a field was read with low confidence', () => {
    const findings = validateInvoice(context({ confidences: { ...CONFIDENT, totalMinor: 0.61 } }));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'LOW_FIELD_CONFIDENCE', severity: 'warning' });
    expect(findings[0].message).toContain('61%');
  });

  it('does not ask for confirmation of an optional field that is simply absent', () => {
    const findings = validateInvoice(
      context({
        record: { ...BASE_RECORD, purchaseOrder: null },
        confidences: { ...CONFIDENT, purchaseOrder: 0.2 },
      }),
    );

    expect(findings).toEqual([]);
  });

  it('blocks an invoice dated in the future', () => {
    const record = { ...BASE_RECORD, invoiceDate: '2026-09-01' };
    const findings = validateInvoice(context({ record }));

    expect(findings.some((f) => f.code === 'DATE_OUTSIDE_POLICY' && f.severity === 'error')).toBe(true);
  });

  it('allows a couple of days of clock skew rather than blocking on a time zone', () => {
    const record = { ...BASE_RECORD, invoiceDate: '2026-07-16' };
    expect(codes(context({ record }))).not.toContain('DATE_OUTSIDE_POLICY');
  });

  it('warns about an invoice old enough to be a re-send', () => {
    const record = { ...BASE_RECORD, invoiceDate: '2024-01-05', dueDate: '2024-02-05' };
    const findings = validateInvoice(context({ record }));

    expect(findings.some((f) => f.code === 'DATE_OUTSIDE_POLICY' && f.severity === 'warning')).toBe(true);
  });

  it('blocks bytes that were already uploaded here', () => {
    expect(codes(context({ duplicateOfDocumentId: 'doc-1' }))).toContain('DUPLICATE_DOCUMENT_HASH');
  });

  it('blocks the same vendor and number arriving as a different file', () => {
    const siblings = [
      { id: 'rec-1', vendorName: 'northwind paper co', invoiceNumber: ' NW-2291 ', totalMinor: 57840 },
    ];

    const findings = validateInvoice(context({ siblings }));
    expect(findings.map((f) => f.code)).toContain('POSSIBLE_DUPLICATE_RECORD');
  });

  it('does not call a different invoice from the same vendor a duplicate', () => {
    const siblings = [
      { id: 'rec-1', vendorName: 'Northwind Paper Co', invoiceNumber: 'NW-2290', totalMinor: 10000 },
    ];

    expect(codes(context({ siblings }))).not.toContain('POSSIBLE_DUPLICATE_RECORD');
  });

  it('rejects a total that is zero or negative', () => {
    const record = { ...BASE_RECORD, lines: [], subtotalMinor: 0, taxMinor: 0, totalMinor: 0 };
    expect(codes(context({ record }))).toContain('NON_POSITIVE_TOTAL');
  });
});

describe('money', () => {
  it('formats minor units without floating point', () => {
    expect(money(481200, 'USD')).toBe('USD 4,812.00');
    expect(money(5, 'EUR')).toBe('EUR 0.05');
    expect(money(-1250, 'GBP')).toBe('-GBP 12.50');
  });
});
