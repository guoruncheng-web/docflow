import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { del, presignUrl, put } from '@vercel/blob';

/**
 * Document storage.
 *
 * The store is private, so an uploaded invoice is not a public URL that outlives
 * the session and can be forwarded, indexed or guessed. Reads are short-lived
 * signed URLs minted per request after the caller's tenancy has been checked,
 * which keeps "who may see this document" an application decision rather than a
 * property of whoever has the link.
 *
 * Keys are prefixed with the organization and carry a random component, so one
 * tenant cannot construct another's key even before signing is considered.
 */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);
  private readonly token: string | undefined;

  /** How long a document link stays valid. Long enough to render, not to share. */
  private readonly readTtlSeconds = 300;

  constructor(config: ConfigService) {
    this.token = config.get<string>('BLOB_READ_WRITE_TOKEN');
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  async upload(input: {
    organizationId: string;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }): Promise<{ key: string; url: string }> {
    const safeName = input.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const key = `org/${input.organizationId}/${randomUUID()}/${safeName}`;

    const result = await put(key, Buffer.from(input.bytes), {
      access: 'private',
      contentType: input.contentType,
      token: this.token,
      // The key already carries a UUID; letting the SDK add its own suffix
      // would mean the stored path is not the one recorded in the database.
      addRandomSuffix: false,
    });

    return { key, url: result.url };
  }

  /** A read URL that expires, minted only after tenancy has been checked. */
  async signedReadUrl(url: string): Promise<string> {
    return presignUrl(url, { token: this.token, expiresIn: this.readTtlSeconds });
  }

  async remove(urls: string[]): Promise<void> {
    if (urls.length === 0) return;

    try {
      await del(urls, { token: this.token });
    } catch (error) {
      // Cleanup failing must not fail the request that triggered it; the
      // reaper will pass over these again.
      this.logger.warn(`Could not delete ${urls.length} blob(s): ${(error as Error).message}`);
    }
  }
}
