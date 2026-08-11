import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * The gallery of documents the demo ships with.
 *
 * A visitor arriving from a portfolio link has no invoices to hand, and asking
 * them to find one before anything happens loses most of them. These are the
 * synthetic PDFs built by `pnpm fixtures`, each chosen to produce a specific
 * outcome, so the gallery can promise "this one is a duplicate" and be right.
 *
 * They travel through exactly the same path as an upload — stored in Blob under
 * the visitor's own prefix, hashed, extracted, validated. Nothing downstream
 * knows a document came from here, which is what keeps the demo honest: the
 * sample invoices are not a rehearsed script, they are input.
 */

export type Sample = {
  slug: string;
  filename: string;
  title: string;
  teaser: string;
  vendorName: string;
  invoiceNumber: string;
  currencyCode: string;
  totalMinor: number;
  byteSize: number;
};

@Injectable()
export class SamplesService {
  private readonly logger = new Logger(SamplesService.name);
  private cached: Sample[] | null = null;

  /**
   * Resolved from the compiled file's location rather than the working
   * directory: on Vercel the function is invoked from somewhere else entirely
   * and `process.cwd()` quietly points at the wrong place.
   *
   * Two candidates because the build stages the fixtures into `dist/` to get
   * them deployed, while `nest start` runs against the ones in the repository.
   */
  private readonly candidates = [
    join(__dirname, '..', '..', 'fixtures', 'invoices'),
    join(__dirname, '..', '..', '..', 'fixtures', 'invoices'),
  ];

  private directory: string | null = null;

  async list(): Promise<Sample[]> {
    if (this.cached) return this.cached;

    for (const candidate of this.candidates) {
      try {
        const manifest = await readFile(join(candidate, 'manifest.json'), 'utf8');
        this.directory = candidate;
        this.cached = JSON.parse(manifest) as Sample[];
        return this.cached;
      } catch {
        continue;
      }
    }

    // A missing gallery is a deployment problem, not a request problem: say so
    // loudly and let the upload path carry on working.
    this.logger.error(`No sample manifest under any of: ${this.candidates.join(', ')}`);
    return [];
  }

  async bytes(slug: string): Promise<{ sample: Sample; bytes: Uint8Array }> {
    const sample = (await this.list()).find((candidate) => candidate.slug === slug);
    if (!sample || !this.directory) throw new NotFoundException(`No sample document called "${slug}".`);

    const file = await readFile(join(this.directory, sample.filename));
    return { sample, bytes: new Uint8Array(file) };
  }
}
