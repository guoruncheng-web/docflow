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
        this.cached = (JSON.parse(manifest) as Sample[]).map((sample) => ({
          ...sample,
          ...(SAMPLE_COPY[sample.slug] ?? {}),
        }));
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

const SAMPLE_COPY: Record<string, Pick<Sample, 'title' | 'teaser'>> = {
  'northwind-clean': { title: '标准票据', teaser: '字段完整、金额一致，可直接进入审核。' },
  'northwind-duplicate': { title: '重复票据', teaser: '与已上传文件完全相同，用于验证重复检测。' },
  'atlas-total-mismatch': { title: '金额不一致', teaser: '明细、小计或税额无法与合计金额对应。' },
  'meridian-foreign-currency': { title: '不支持的币种', teaser: '识别有效，但目标财务系统无法入账。' },
  'harborline-future-dated': { title: '未来日期', teaser: '开票日期超出规则允许范围，需要人工确认。' },
  'quill-prompt-injection': { title: '提示词注入', teaser: '票据中包含针对模型的恶意指令，用于验证防护。' },
};
