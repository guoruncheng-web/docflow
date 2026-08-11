import { pathToFileURL } from 'node:url';

/**
 * Reads a PDF's text layer along with where each word sits on the page.
 *
 * The geometry is the point. An extractor that returns "the total is 4,812.00"
 * asks the reviewer to take its word for it; one that can also say "and it is
 * these pixels, on page 1" lets them check it in the time it takes to glance.
 * Everything the review screen draws over the document comes from here, which
 * is why evidence is matched against real word positions rather than asked of
 * the model — a model will happily invent plausible coordinates.
 *
 * This handles digital PDFs, which is what invoices from any modern accounting
 * package are. A scan has no text layer and needs a real OCR provider; the
 * public demo says so rather than pretending, and `OcrAdapter` is the seam
 * where such a provider would be added.
 */

export type WordBox = {
  text: string;
  /** PDF user-space units with the origin at the top-left, matching the DOM. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExtractedPage = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  words: WordBox[];
};

export type ExtractedDocument = {
  provider: string;
  pages: ExtractedPage[];
};

export interface OcrAdapter {
  readonly name: string;
  extract(bytes: Uint8Array): Promise<ExtractedDocument>;
}

/** Thrown when a file cannot be read as a document rather than merely failing. */
export class DocumentReadError extends Error {
  constructor(
    readonly reason: 'unreadable' | 'no_text_layer' | 'too_many_pages',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentReadError';
  }
}

const MAX_PAGES = 10;

/**
 * Loading pdf.js from CommonJS, without disappearing from the bundler.
 *
 * pdf.js 4 ships ESM only, and this compiles to CommonJS, where TypeScript
 * rewrites `import()` into `require()` — which cannot load an `.mjs` file and
 * fails at runtime rather than at build time. Hiding the expression inside
 * `Function` leaves a genuine dynamic import that Node performs happily.
 *
 * But hiding it from TypeScript also hides it from the deployment's dependency
 * tracer, which then ships a function with no pdf.js in it and a stack trace
 * that arrives on the first real document. `require.resolve` is the fix for
 * both halves: it is static enough for the tracer to follow, and it hands back
 * the absolute path the dynamic import needs.
 */
const PDFJS_ENTRY = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * The worker is resolved for the same reason, and named explicitly.
 *
 * Outside a browser pdf.js still loads its worker — it imports `pdf.worker.mjs`
 * at the first document rather than at startup, so a bundle missing it deploys
 * cleanly, passes a health check, and fails on the first real upload with a
 * message about a "fake worker" that says nothing about the actual cause.
 */
const PDFJS_WORKER = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>;

async function importPdfjs() {
  const pdfjs = await importEsm(pathToFileURL(PDFJS_ENTRY).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(PDFJS_WORKER).href;
  return pdfjs;
}

export class PdfTextLayerAdapter implements OcrAdapter {
  readonly name = 'pdfjs-text-layer';

  async extract(bytes: Uint8Array): Promise<ExtractedDocument> {
    // Loaded lazily: paying pdf.js's parse cost on every cold start would tax
    // requests that never touch a document.
    const pdfjs = await importPdfjs();

    let document;
    try {
      document = await pdfjs.getDocument({
        data: bytes,
        // No worker thread, no fonts to draw, no canvas: this reads text.
        useWorkerFetch: false,
        isEvalSupported: false,
        disableFontFace: true,
      }).promise;
    } catch (error) {
      throw new DocumentReadError(
        'unreadable',
        `This file could not be opened as a PDF (${(error as Error).message}). Encrypted and damaged files are rejected rather than half-read.`,
      );
    }

    if (document.numPages > MAX_PAGES) {
      throw new DocumentReadError(
        'too_many_pages',
        `This document has ${document.numPages} pages; the demo accepts up to ${MAX_PAGES}.`,
      );
    }

    const pages: ExtractedPage[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const words: WordBox[] = [];

      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;

        // transform is [a, b, c, d, e, f]; e and f are the baseline origin, and
        // d carries the glyph height for the unrotated text this handles.
        const [, , , scaleY, originX, originY] = item.transform;
        const height = Math.abs(scaleY) || item.height || 10;

        words.push({
          text: item.str,
          x: originX,
          // pdf.js measures from the bottom-left; browsers from the top-left.
          // Converting here means nothing downstream has to remember which.
          y: viewport.height - originY - height,
          width: item.width,
          height,
        });
      }

      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        text: linesFrom(words),
        words,
      });

      page.cleanup();
    }

    await document.destroy();

    const characters = pages.reduce((total, page) => total + page.text.trim().length, 0);
    if (characters < 40) {
      throw new DocumentReadError(
        'no_text_layer',
        'This PDF has no text layer, which means it is a scan. The public demo reads digital documents; a scanned one needs an OCR provider, and pretending otherwise would waste your time.',
      );
    }

    return { provider: this.name, pages };
  }
}

/**
 * Rebuilds reading order from positions.
 *
 * A PDF's text items arrive in drawing order, which is not reading order: a
 * table's amount column is often written after every description. Feeding that
 * sequence to a model produces confident nonsense about which number belongs to
 * which row, so items are grouped into lines by vertical position and sorted
 * left to right within each line.
 */
export function linesFrom(words: WordBox[]): string {
  if (words.length === 0) return '';

  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: WordBox[][] = [];

  for (const word of sorted) {
    const line = lines.at(-1);
    // Half the glyph height tolerates the baseline jitter of mixed font sizes
    // on one visual row without merging genuinely separate rows.
    const tolerance = Math.max(word.height, line?.[0]?.height ?? 0) / 2;

    if (line && Math.abs(line[0].y - word.y) <= tolerance) {
      line.push(word);
    } else {
      lines.push([word]);
    }
  }

  return lines
    .map((line) =>
      [...line]
        .sort((a, b) => a.x - b.x)
        .map((word) => word.text.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Finds where a quoted fragment sits on the page.
 *
 * The model returns the text it read, not coordinates, because text can be
 * checked against the document and coordinates cannot. This walks the page's
 * words for the run that matches the quote and returns the box around it, so a
 * fabricated quote produces no highlight — which is exactly the signal a
 * reviewer needs.
 */
export function locateQuote(page: ExtractedPage, quote: string): WordBox | null {
  const needle = collapse(quote);
  if (!needle) return null;

  const words = [...page.words].sort((a, b) => a.y - b.y || a.x - b.x);

  for (let start = 0; start < words.length; start += 1) {
    let joined = '';

    for (let end = start; end < words.length && end < start + 40; end += 1) {
      joined = collapse(`${joined} ${words[end].text}`);
      if (!needle.startsWith(joined)) break;

      if (joined === needle) {
        return boundingBox(words.slice(start, end + 1));
      }
    }
  }

  // A quote spanning a line break, or one the model tidied up, still deserves a
  // highlight if a single item contains it.
  const containing = words.find((word) => collapse(word.text).includes(needle));
  return containing ? { ...containing } : null;
}

function boundingBox(words: WordBox[]): WordBox {
  const left = Math.min(...words.map((word) => word.x));
  const top = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.width));
  const bottom = Math.max(...words.map((word) => word.y + word.height));

  return {
    text: words.map((word) => word.text).join(' '),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
