import { createRequire } from "node:module";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copies Swagger UI's stylesheet and bundles into `public/`.
 *
 * `SwaggerModule.setup` normally serves these out of `node_modules` through an
 * Express middleware. That works under `nest start` and fails on Vercel, where
 * the function ships `dist/` and nothing else: the page renders, its assets
 * 404, and the visitor gets a blank white screen with a 200 next to it — which
 * is exactly how this went unnoticed, since a health check on `/api/docs` is
 * perfectly happy.
 *
 * Copying them into the static output directory means the CDN serves them
 * before the request ever reaches the function, and the same files back local
 * development, so the two behave alike.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const destination = join(here, "..", "public", "docs-assets");

const ASSETS = [
  "swagger-ui.css",
  "swagger-ui-bundle.js",
  "swagger-ui-standalone-preset.js",
  "favicon-32x32.png",
  "favicon-16x16.png",
];

await mkdir(destination, { recursive: true });

for (const asset of ASSETS) {
  await copyFile(require.resolve(`swagger-ui-dist/${asset}`), join(destination, asset));
}

console.log(`Copied ${ASSETS.length} Swagger UI assets into public/docs-assets`);
