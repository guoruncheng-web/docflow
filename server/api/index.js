// Vercel serverless entry point.
//
// Plain JavaScript on purpose: it requires the output of `nest build`, so the
// decorator metadata Nest depends on is emitted by tsc during the build step
// rather than by whatever transform the platform applies to a function's source.
//
// The Express instance is cached on the module scope. Vercel reuses a warm
// container across invocations, so bootstrapping happens once per container
// instead of once per request. The promise itself is cached rather than the
// resolved app, otherwise two concurrent cold requests would each bootstrap.

const { createApp } = require('../dist/src/bootstrap');

let handlerPromise;

async function buildHandler() {
  const app = await createApp();
  return app.getHttpAdapter().getInstance();
}

module.exports = async function handler(req, res) {
  if (!handlerPromise) {
    handlerPromise = buildHandler().catch((error) => {
      // Let the next request retry instead of caching a permanently broken app.
      handlerPromise = undefined;
      throw error;
    });
  }

  const expressApp = await handlerPromise;
  return expressApp(req, res);
};
