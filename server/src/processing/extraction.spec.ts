import { documentTextForModel, extractInvoice, extractJson } from './extraction';
import type { CompleteFn } from './extraction';
import type { ExtractedDocument } from './pdf-text';
import type { CompletionResult } from '../llm/llm.types';

const PAGE_WORDS = [
  { text: 'Northwind Paper Co', x: 48, y: 60, width: 120, height: 12 },
  { text: 'Invoice number', x: 330, y: 120, width: 70, height: 9 },
  { text: 'NW-2291', x: 450, y: 120, width: 45, height: 10 },
  { text: 'Total due', x: 330, y: 500, width: 50, height: 11 },
  { text: '$578.40', x: 470, y: 500, width: 45, height: 11 },
];

const DOCUMENT: ExtractedDocument = {
  provider: 'test',
  pages: [
    {
      pageNumber: 1,
      width: 595,
      height: 842,
      text: 'Northwind Paper Co\nInvoice number NW-2291\nTotal due $578.40',
      words: PAGE_WORDS,
    },
  ],
};

function answer(overrides: Record<string, unknown> = {}): string {
  const proposed = (value: unknown, confidence = 0.95, quote?: string) => ({
    value,
    confidence,
    evidence: quote ? { page: 1, quote } : null,
  });

  return JSON.stringify({
    vendorName: proposed('Northwind Paper Co', 0.97, 'Northwind Paper Co'),
    invoiceNumber: proposed('NW-2291', 0.96, 'NW-2291'),
    invoiceDate: proposed('2026-07-02'),
    dueDate: proposed('2026-08-01'),
    purchaseOrder: proposed(null, 0.3),
    currency: proposed('usd', 0.99),
    lines: [{ description: 'A4 paper', quantity: 40, unitPriceMinor: 1150, amountMinor: 46000 }],
    subtotalMinor: proposed(48200),
    taxMinor: proposed(9640),
    totalMinor: proposed(57840, 0.98, 'Total due $578.40'),
    ...overrides,
  });
}

function completion(text: string): CompletionResult {
  return {
    text,
    model: 'test-model',
    provider: 'test',
    inputTokens: 100,
    outputTokens: 50,
    costMicros: 40,
    latencyMs: 10,
    ttfbMs: 5,
  };
}

const replying = (...texts: string[]): CompleteFn => {
  let call = 0;
  return async () => completion(texts[Math.min(call++, texts.length - 1)]);
};

const noSleep = async () => {};

describe('extractInvoice', () => {
  it('splits the answer into a record, confidences and provenance', async () => {
    const result = await extractInvoice({ document: DOCUMENT, complete: replying(answer()), sleep: noSleep });

    expect(result.record.vendorName).toBe('Northwind Paper Co');
    expect(result.record.totalMinor).toBe(57840);
    // The record a person edits carries values, not wrappers.
    expect(result.record).not.toHaveProperty('vendorName.value');
    expect(result.confidences.totalMinor).toBe(0.98);
    expect(result.attempts).toEqual([{ attempt: 1, outcome: 'ok' }]);
  });

  it('normalises the currency the destination will be asked to book', async () => {
    const result = await extractInvoice({ document: DOCUMENT, complete: replying(answer()), sleep: noSleep });
    expect(result.record.currency).toBe('USD');
  });

  it('locates a quoted value in the real page geometry', async () => {
    const result = await extractInvoice({ document: DOCUMENT, complete: replying(answer()), sleep: noSleep });
    const total = result.proposals.find((proposal) => proposal.fieldPath === 'totalMinor');

    expect(total?.method).toBe('llm+evidence');
    expect(total?.evidenceBox).not.toBeNull();
    const [x, y, width] = total!.evidenceBox!;
    expect(x).toBe(330);
    expect(y).toBe(500);
    expect(width).toBeGreaterThan(100);
  });

  it('marks a value whose quote is nowhere in the document', async () => {
    const invented = answer({
      totalMinor: { value: 99999, confidence: 0.99, evidence: { page: 1, quote: 'Total due $999.99' } },
    });

    const result = await extractInvoice({ document: DOCUMENT, complete: replying(invented), sleep: noSleep });
    const total = result.proposals.find((proposal) => proposal.fieldPath === 'totalMinor');

    // High confidence and a quote that does not exist is precisely the case a
    // confidence score alone would hide.
    expect(total?.method).toBe('llm+unverified-quote');
    expect(total?.evidenceBox).toBeNull();
  });

  it('marks a value the model did not even claim to have read', async () => {
    const result = await extractInvoice({ document: DOCUMENT, complete: replying(answer()), sleep: noSleep });
    const date = result.proposals.find((proposal) => proposal.fieldPath === 'invoiceDate');

    expect(date?.method).toBe('llm+no-evidence');
  });

  it('re-asks with the complaint attached when the answer fails the schema', async () => {
    const broken = answer({ totalMinor: { value: 578.4, confidence: 0.9, evidence: null } });
    const messages: string[] = [];

    const complete: CompleteFn = async ({ messages: sent }) => {
      messages.push(sent.map((message) => `${message.role}:${message.content}`).join('|'));
      return completion(messages.length === 1 ? broken : answer());
    };

    const result = await extractInvoice({ document: DOCUMENT, complete, sleep: noSleep });

    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(['invalid_output', 'ok']);
    // The second request must contain the rejected output and the reason, or it
    // is just the same question asked twice.
    expect(messages[1]).toContain('assistant:');
    expect(messages[1]).toContain('totalMinor');
    expect(messages[1]).toMatch(/integer minor units/i);
    expect(result.record.totalMinor).toBe(57840);
  });

  it('gives up rather than accepting output that never satisfies the schema', async () => {
    const broken = answer({ vendorName: { value: '', confidence: 0.9, evidence: null } });

    await expect(
      extractInvoice({ document: DOCUMENT, complete: replying(broken), sleep: noSleep }),
    ).rejects.toThrow(/vendorName/);
  });

  it('reports every attempt, including the ones that failed', async () => {
    const broken = answer({ currency: { value: 'DOLLARS', confidence: 0.9, evidence: null } });
    const seen: string[] = [];

    await extractInvoice({
      document: DOCUMENT,
      complete: replying(broken, answer()),
      onAttempt: (record) => void seen.push(record.outcome),
      sleep: noSleep,
    }).catch(() => undefined);

    expect(seen[0]).toBe('invalid_output');
  });
});

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores a sentence the model added first', () => {
    expect(extractJson('Here is the invoice:\n{"a":1}')).toEqual({ a: 1 });
  });

  it('throws on a truncated object rather than returning half an invoice', () => {
    expect(() => extractJson('{"a":1,"b":')).toThrow();
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('I could not read this document.')).toThrow(/no JSON object/);
  });
});

describe('documentTextForModel', () => {
  it('keeps both ends of a long document, where identity and totals live', () => {
    const long = 'x'.repeat(20_000);
    const document: ExtractedDocument = {
      provider: 'test',
      pages: [{ pageNumber: 1, width: 595, height: 842, text: `START${long}END`, words: [] }],
    };

    const text = documentTextForModel(document);

    expect(text).toContain('START');
    expect(text).toContain('END');
    expect(text).toContain('characters omitted');
    expect(text.length).toBeLessThan(13_000);
  });

  it('leaves a short document alone', () => {
    expect(documentTextForModel(DOCUMENT)).toContain('--- page 1 ---');
  });
});
