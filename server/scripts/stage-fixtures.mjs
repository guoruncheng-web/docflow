import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the sample invoices into `dist/` so they ship with the function.
 *
 * Vercel includes exactly what `functions.includeFiles` matches, and that
 * option takes one glob — a brace group like `{dist,fixtures}/**` matches
 * nothing at all, silently, and the deployment only fails when the first
 * request tries to read a file that was never uploaded. Staging the fixtures
 * inside the tree that is already included avoids depending on glob syntax
 * that looks supported and is not.
 */

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', 'fixtures');
const to = join(here, '..', 'dist', 'fixtures');

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });

console.log('Staged sample documents into dist/fixtures');
