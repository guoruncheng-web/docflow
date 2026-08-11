import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DocumentReadError, PdfTextLayerAdapter, linesFrom, locateQuote, type WordBox } from './pdf-text';

const fixture = (name: string) => join(__dirname, '..', '..', '..', 'fixtures', 'invoices', name);

const word = (text: string, x: number, y: number, width = text.length * 5, height = 10): WordBox => ({
  text,
  x,
  y,
  width,
  height,
});

describe('linesFrom', () => {
  it('rebuilds reading order from position, not from drawing order', () => {
    // A table drawn column by column: every description first, then every
    // amount. Read in drawing order this says the second item costs $46.00.
    const words = [
      word('A4 paper', 48, 300),
      word('Delivery', 48, 318),
      word('460.00', 495, 300),
      word('22.00', 495, 318),
    ];

    expect(linesFrom(words)).toBe('A4 paper 460.00\nDelivery 22.00');
  });

  it('keeps words of different sizes on one visual row together', () => {
    const words = [word('Total due', 330, 500, 60, 11), word('578.40', 470, 501, 40, 11)];
    expect(linesFrom(words)).toBe('Total due 578.40');
  });

  it('does not merge rows that are genuinely separate', () => {
    expect(linesFrom([word('Subtotal', 330, 480), word('Total', 330, 500)])).toBe('Subtotal\nTotal');
  });

  it('returns nothing for a page with no words rather than a stray newline', () => {
    expect(linesFrom([])).toBe('');
  });
});

describe('locateQuote', () => {
  const page = {
    pageNumber: 1,
    width: 595,
    height: 842,
    text: '',
    words: [word('Total', 330, 500, 30), word('due', 364, 500, 20), word('$578.40', 470, 500, 45)],
  };

  it('finds a run of words and returns the box around all of them', () => {
    const box = locateQuote(page, 'Total due');

    expect(box).not.toBeNull();
    expect(box!.x).toBe(330);
    expect(box!.width).toBe(54);
  });

  it('matches regardless of spacing and case, which the model does not preserve', () => {
    expect(locateQuote(page, '  TOTAL   DUE ')).not.toBeNull();
  });

  it('returns nothing for a quote that is not in the document', () => {
    // A fabricated quote must not produce a highlight — a box drawn around
    // nothing would make an invented value look verified.
    expect(locateQuote(page, 'Total paid in advance')).toBeNull();
  });

  it('still highlights when the quote is part of a single item', () => {
    expect(locateQuote(page, '578.40')).not.toBeNull();
  });
});

describe('PdfTextLayerAdapter', () => {
  const adapter = new PdfTextLayerAdapter();

  it('reads a generated invoice into positioned text', async () => {
    const bytes = await readFile(fixture('northwind-clean.pdf'));
    const document = await adapter.extract(new Uint8Array(bytes));

    expect(document.pages).toHaveLength(1);

    const [page] = document.pages;
    expect(page.width).toBeCloseTo(595, 0);
    expect(page.text).toContain('Northwind Paper Co');
    expect(page.text).toContain('NW-2291');
    // The amount belongs on the same line as its description, which only holds
    // if reading order was rebuilt from geometry.
    expect(page.text).toMatch(/A4 paper.*460\.00/);
  });

  it('locates a quote from a real invoice on the page', async () => {
    const bytes = await readFile(fixture('northwind-clean.pdf'));
    const [page] = (await adapter.extract(new Uint8Array(bytes))).pages;

    const box = locateQuote(page, 'NW-2291');

    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.height);
  });

  it('rejects a file that is not a PDF instead of extracting nothing from it', async () => {
    await expect(adapter.extract(new TextEncoder().encode('this is not a pdf'))).rejects.toBeInstanceOf(
      DocumentReadError,
    );
  });
});
