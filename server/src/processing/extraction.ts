import { z } from 'zod';
import { LlmError } from '../llm/llm.types';
import type { CompletionResult } from '../llm/llm.types';
import { DEFAULT_RETRY, withRetry, type AttemptRecord } from '../llm/retry';
import {
  INVOICE_PROMPT_VERSION,
  invoiceExtractionPrompt,
  invoiceExtractionSchema,
  type InvoiceExtraction,
  type InvoiceRecord,
} from '../templates/invoice.template';
import { locateQuote, type ExtractedDocument, type WordBox } from './pdf-text';

/**
 * Turning a document into proposed fields.
 *
 * Three things happen here that are easy to leave out and expensive to add
 * later. The model's answer is validated against a schema before anything
 * downstream sees it; a schema failure is re-asked with the specific complaint
 * attached rather than simply repeated; and every quoted value is located in
 * the real page geometry, so a value the model invented cannot be highlighted
 * as if it had been read.
 */

export type ProposedField = {
  fieldPath: string;
  rawValue: string | null;
  normalizedValue: unknown;
  confidence: number;
  method: string;
  pageNumber: number | null;
  evidenceText: string | null;
  evidenceBox: [number, number, number, number] | null;
};

export type ExtractionResult = {
  record: InvoiceRecord;
  confidences: Record<string, number>;
  proposals: ProposedField[];
  attempts: AttemptRecord[];
  calls: CompletionResult[];
  promptVersion: string;
};

export type CompleteFn = (input: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  onToken?: (token: string) => void;
}) => Promise<CompletionResult>;

/**
 * How much of the document the model is shown.
 *
 * An invoice's identifying data is at the top and its totals at the bottom, so
 * a naive head-truncation loses exactly the number that matters most. Long
 * documents keep both ends and drop the middle, which for a line-item table
 * costs detail rather than identity.
 */
const MAX_CHARACTERS = 12_000;

export function documentTextForModel(document: ExtractedDocument): string {
  const full = document.pages
    .map((page) => `--- page ${page.pageNumber} ---\n${page.text}`)
    .join('\n\n');

  if (full.length <= MAX_CHARACTERS) return full;

  const half = Math.floor(MAX_CHARACTERS / 2);
  return `${full.slice(0, half)}\n\n[... ${full.length - MAX_CHARACTERS} characters omitted ...]\n\n${full.slice(-half)}`;
}

export async function extractInvoice(input: {
  document: ExtractedDocument;
  complete: CompleteFn;
  onToken?: (token: string) => void;
  onAttempt?: (record: AttemptRecord) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<ExtractionResult> {
  const { system, user } = invoiceExtractionPrompt(documentTextForModel(input.document));
  const calls: CompletionResult[] = [];
  const attempts: AttemptRecord[] = [];

  let complaint: { output: string; problem: string } | null = null;

  const parsed = await withRetry<InvoiceExtraction>(
    async () => {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      // The repair turn shows the model its own rejected output and the exact
      // validation error. Re-sending the original question unchanged gets the
      // same answer back, because nothing told it what was wrong.
      if (complaint) {
        messages.push({ role: 'assistant', content: complaint.output });
        messages.push({
          role: 'user',
          content: `That response was rejected: ${complaint.problem}\n\nReturn the corrected JSON object only. Keep every value you are still confident about; do not lower confidence to avoid the error, and do not add fields that are not in the shape.`,
        });
      }

      const call = await input.complete({ messages, onToken: input.onToken });
      calls.push(call);

      const json = extractJson(call.text);
      const result = invoiceExtractionSchema.safeParse(json);

      if (!result.success) {
        const problem = describe(result.error);
        complaint = { output: call.text.slice(0, 4_000), problem };
        throw new LlmError('invalid_output', problem);
      }

      return result.data;
    },
    {
      policy: { ...DEFAULT_RETRY, maxAttempts: 3 },
      sleep: input.sleep,
      onAttempt: async (record) => {
        attempts.push(record);
        await input.onAttempt?.(record);
      },
      // The default policy refuses to retry invalid output, and it is right to:
      // an identical request produces an identical answer. This path earns the
      // retry by changing the request, and says so explicitly rather than
      // dressing the error up as something retryable to slip past the rule.
      isRetryable: (error) =>
        error instanceof LlmError && (error.retryable || error.kind === 'invalid_output'),
    },
  );

  const { record, confidences, proposals } = materialise(parsed, input.document);

  return { record, confidences, proposals, attempts, calls, promptVersion: INVOICE_PROMPT_VERSION };
}

/**
 * Splits the model's answer into the record a person will edit, the confidence
 * behind each value, and the provenance of each — three different audiences for
 * the same response.
 */
function materialise(
  extraction: InvoiceExtraction,
  document: ExtractedDocument,
): { record: InvoiceRecord; confidences: Record<string, number>; proposals: ProposedField[] } {
  const record = {
    vendorName: extraction.vendorName.value,
    invoiceNumber: extraction.invoiceNumber.value,
    invoiceDate: extraction.invoiceDate.value,
    dueDate: extraction.dueDate.value,
    purchaseOrder: extraction.purchaseOrder.value,
    currency: extraction.currency.value.toUpperCase(),
    lines: extraction.lines,
    subtotalMinor: extraction.subtotalMinor.value,
    taxMinor: extraction.taxMinor.value,
    totalMinor: extraction.totalMinor.value,
  } satisfies InvoiceRecord;

  const confidences: Record<string, number> = {};
  const proposals: ProposedField[] = [];

  for (const [path, proposed] of Object.entries(extraction)) {
    if (path === 'lines') continue;

    const field = proposed as InvoiceExtraction['vendorName'];
    confidences[path] = field.confidence;

    const located = field.evidence ? locate(document, field.evidence.page, field.evidence.quote) : null;

    proposals.push({
      fieldPath: path,
      rawValue: field.value === null ? null : String(field.value),
      normalizedValue: field.value,
      confidence: field.confidence,
      // A value whose quote cannot be found in the document was not read from
      // it, whatever the model believes. Saying so is more useful than a
      // confidence score, because it is a fact about the document.
      method: field.evidence ? (located ? 'llm+evidence' : 'llm+unverified-quote') : 'llm+no-evidence',
      pageNumber: field.evidence?.page ?? null,
      evidenceText: field.evidence?.quote ?? null,
      evidenceBox: located ? [round(located.x), round(located.y), round(located.width), round(located.height)] : null,
    });
  }

  extraction.lines.forEach((line, index) => {
    proposals.push({
      fieldPath: `lines.${index}`,
      rawValue: line.description,
      normalizedValue: line,
      // Lines are not separately scored by the model; they inherit nothing and
      // claim nothing, and the arithmetic rules check them instead.
      confidence: 1,
      method: 'llm',
      pageNumber: null,
      evidenceText: null,
      evidenceBox: null,
    });
  });

  return { record, confidences, proposals };
}

function locate(document: ExtractedDocument, pageNumber: number, quote: string): WordBox | null {
  const page = document.pages.find((candidate) => candidate.pageNumber === pageNumber);
  if (!page) return null;

  const box = locateQuote(page, quote);
  if (!box) return null;

  // A box outside the page cannot be drawn over it. Coordinates are checked
  // rather than trusted, because an out-of-bounds highlight silently lands
  // somewhere plausible-looking and misleads.
  const withinBounds =
    box.x >= 0 && box.y >= 0 && box.x + box.width <= page.width + 1 && box.y + box.height <= page.height + 1;

  return withinBounds ? box : null;
}

/**
 * Pulls the JSON object out of a reply.
 *
 * Models fence their JSON, introduce it with a sentence, or do both, and a
 * `JSON.parse` of the raw reply fails on all of it. A truncated object throws
 * rather than returning the fragment that parsed — half an invoice is worse
 * than none, because it looks like a whole one.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    throw new SyntaxError('The response contained no JSON object.');
  }

  return JSON.parse(candidate.slice(start, end + 1));
}

/** A validation error a model can act on: the path and what was wrong with it. */
function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
