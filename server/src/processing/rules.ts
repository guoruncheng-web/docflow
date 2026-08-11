import type { FieldPolicy, InvoiceRecord } from '../templates/invoice.template';
import { SUPPORTED_CURRENCIES } from '../templates/invoice.template';

/**
 * Deterministic validation.
 *
 * These are ordinary functions with stable codes and fixtures, deliberately not
 * a second model call asking "does this look right". A model that judges its
 * own output is confident in the same places it was wrong, and its verdict
 * cannot be unit tested, counted over time, or explained to a client who asks
 * why an invoice was held. Arithmetic is arithmetic.
 *
 * Severity is the whole contract with the approval policy: `error` blocks
 * approval, `warning` must be acknowledged. Codes never change once shipped —
 * they end up in dashboards and in conversations about "the duplicate rule".
 */

export type Severity = 'error' | 'warning';

export type Finding = {
  code: string;
  severity: Severity;
  fieldPath: string | null;
  message: string;
};

export type RuleContext = {
  record: InvoiceRecord;
  confidences: Record<string, number>;
  policies: FieldPolicy[];
  /** Other invoices already in this workspace, for duplicate detection. */
  siblings: Array<{ id: string; vendorName: string; invoiceNumber: string; totalMinor: number }>;
  /** True when the uploaded bytes match a document already stored here. */
  duplicateOfDocumentId: string | null;
  today: Date;
};

/** How far ahead of today an invoice date is still plausible rather than a typo. */
const FUTURE_DATE_TOLERANCE_DAYS = 2;

/** Invoices older than this are usually a re-send of something already paid. */
const STALE_INVOICE_DAYS = 365;

export function validateInvoice(context: RuleContext): Finding[] {
  return [
    ...requiredFields(context),
    ...lowConfidence(context),
    ...currencySupported(context),
    ...arithmetic(context),
    ...dates(context),
    ...duplicates(context),
  ];
}

function requiredFields({ record, policies }: RuleContext): Finding[] {
  return policies
    .filter((policy) => policy.required)
    .filter((policy) => isEmpty((record as unknown as Record<string, unknown>)[policy.path]))
    .map((policy) => ({
      code: 'REQUIRED_FIELD_MISSING',
      severity: 'error' as const,
      fieldPath: policy.path,
      message: `${policy.label} is required and was not found in the document.`,
    }));
}

function lowConfidence({ confidences, policies, record }: RuleContext): Finding[] {
  return policies
    .filter((policy) => {
      const confidence = confidences[policy.path];
      if (confidence === undefined) return false;
      // An absent optional field is not a low-confidence field; it is an absent
      // field, and asking someone to confirm a null they can see is noise.
      if (!policy.required && isEmpty((record as unknown as Record<string, unknown>)[policy.path])) return false;
      return confidence < policy.reviewBelow;
    })
    .map((policy) => ({
      code: 'LOW_FIELD_CONFIDENCE',
      severity: 'warning' as const,
      fieldPath: policy.path,
      message: `${policy.label} was read with ${(confidences[policy.path] * 100).toFixed(0)}% confidence, below the ${(policy.reviewBelow * 100).toFixed(0)}% this field requires. Confirm it against the document.`,
    }));
}

function currencySupported({ record }: RuleContext): Finding[] {
  if (!record.currency) return [];
  if ((SUPPORTED_CURRENCIES as readonly string[]).includes(record.currency)) return [];

  return [
    {
      code: 'UNSUPPORTED_CURRENCY',
      severity: 'error',
      fieldPath: 'currency',
      message: `${record.currency} is not one of the currencies this destination can book (${SUPPORTED_CURRENCIES.join(', ')}).`,
    },
  ];
}

function arithmetic({ record }: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const lineSum = record.lines.reduce((total, line) => total + line.amountMinor, 0);

  if (record.lines.length > 0 && lineSum !== record.subtotalMinor) {
    findings.push({
      code: 'CROSS_FIELD_INCONSISTENCY',
      severity: 'error',
      fieldPath: 'subtotalMinor',
      message: `The line items add up to ${money(lineSum, record.currency)}, but the subtotal reads ${money(record.subtotalMinor, record.currency)}.`,
    });
  }

  if (record.subtotalMinor + record.taxMinor !== record.totalMinor) {
    findings.push({
      code: 'TOTAL_MISMATCH',
      severity: 'error',
      fieldPath: 'totalMinor',
      message: `Subtotal ${money(record.subtotalMinor, record.currency)} plus tax ${money(record.taxMinor, record.currency)} is ${money(record.subtotalMinor + record.taxMinor, record.currency)}, not the stated total of ${money(record.totalMinor, record.currency)}.`,
    });
  }

  for (const [index, line] of record.lines.entries()) {
    // Rounding on a per-line basis is legitimate — a unit price of a third of a
    // cent has to land somewhere — so a line is only wrong when it is off by
    // more than a cent.
    const expected = Math.round(line.quantity * line.unitPriceMinor);
    if (Math.abs(expected - line.amountMinor) > 1) {
      findings.push({
        code: 'LINE_AMOUNT_MISMATCH',
        severity: 'warning',
        fieldPath: `lines.${index}.amountMinor`,
        message: `Line ${index + 1}: ${line.quantity} × ${money(line.unitPriceMinor, record.currency)} is ${money(expected, record.currency)}, but the line reads ${money(line.amountMinor, record.currency)}.`,
      });
    }
  }

  if (record.totalMinor <= 0) {
    findings.push({
      code: 'NON_POSITIVE_TOTAL',
      severity: 'error',
      fieldPath: 'totalMinor',
      message: 'The total is zero or negative. A credit note is not an invoice and should not be booked as one.',
    });
  }

  return findings;
}

function dates({ record, today }: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const invoiceDate = parseDate(record.invoiceDate);

  if (record.invoiceDate && !invoiceDate) {
    findings.push({
      code: 'DATE_UNPARSEABLE',
      severity: 'error',
      fieldPath: 'invoiceDate',
      message: `"${record.invoiceDate}" is not a date this system can read.`,
    });
    return findings;
  }

  if (invoiceDate) {
    const daysAhead = daysBetween(today, invoiceDate);

    if (daysAhead > FUTURE_DATE_TOLERANCE_DAYS) {
      findings.push({
        code: 'DATE_OUTSIDE_POLICY',
        severity: 'error',
        fieldPath: 'invoiceDate',
        message: `The invoice is dated ${record.invoiceDate}, ${Math.round(daysAhead)} days in the future.`,
      });
    } else if (daysBetween(invoiceDate, today) > STALE_INVOICE_DAYS) {
      findings.push({
        code: 'DATE_OUTSIDE_POLICY',
        severity: 'warning',
        fieldPath: 'invoiceDate',
        message: `The invoice is dated ${record.invoiceDate}, more than a year ago. Check it is not a re-send of something already paid.`,
      });
    }
  }

  const dueDate = record.dueDate ? parseDate(record.dueDate) : null;
  if (dueDate && invoiceDate && dueDate < invoiceDate) {
    findings.push({
      code: 'CROSS_FIELD_INCONSISTENCY',
      severity: 'warning',
      fieldPath: 'dueDate',
      message: `The due date ${record.dueDate} is before the invoice date ${record.invoiceDate}.`,
    });
  }

  return findings;
}

function duplicates({ record, siblings, duplicateOfDocumentId }: RuleContext): Finding[] {
  const findings: Finding[] = [];

  if (duplicateOfDocumentId) {
    findings.push({
      code: 'DUPLICATE_DOCUMENT_HASH',
      severity: 'error',
      fieldPath: null,
      message: 'These exact bytes have already been uploaded to this workspace. Paying it twice is the expensive mistake this check exists to prevent.',
    });
  }

  // The same vendor and invoice number is a duplicate even when the file
  // differs — a re-scan, a re-export or a reminder copy is a different file
  // carrying the same obligation.
  const match = siblings.find(
    (sibling) =>
      normalize(sibling.vendorName) === normalize(record.vendorName) &&
      normalize(sibling.invoiceNumber) === normalize(record.invoiceNumber),
  );

  if (match) {
    findings.push({
      code: 'POSSIBLE_DUPLICATE_RECORD',
      severity: 'error',
      fieldPath: 'invoiceNumber',
      message: `${record.vendorName} invoice ${record.invoiceNumber} is already in this workspace${match.totalMinor === record.totalMinor ? ' for the same amount' : ` for ${money(match.totalMinor, record.currency)}`}.`,
    });
  }

  return findings;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

export function money(minor: number, currency: string): string {
  const sign = minor < 0 ? '-' : '';
  const absolute = Math.abs(minor);
  return `${sign}${currency} ${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
}
