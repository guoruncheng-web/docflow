import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Private filesystem storage used by the mainland deployment. */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('LOCAL_STORAGE_ROOT') ?? '/data/documents');
  }

  get configured(): boolean {
    return true;
  }

  async upload(input: {
    organizationId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ key: string; url: string }> {
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const key = `org/${input.organizationId}/${randomUUID()}/${safeName}`;
    const target = this.pathFor(key);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.bytes, { mode: 0o600 });
    return { key, url: `local://${key}` };
  }

  async read(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  async remove(urls: string[]): Promise<void> {
    for (const url of urls) {
      const key = url.startsWith('local://') ? url.slice('local://'.length) : url;
      try {
        await rm(this.pathFor(key), { force: true });
      } catch (error) {
        this.logger.warn(`Could not delete ${key}: ${(error as Error).message}`);
      }
    }
  }

  private pathFor(key: string): string {
    const target = resolve(join(this.root, key));
    if (target !== this.root && !target.startsWith(`${this.root}/`)) {
      throw new Error('Invalid document storage key.');
    }
    return target;
  }
}
