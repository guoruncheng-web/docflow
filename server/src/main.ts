import { createApp } from './bootstrap';

async function main(): Promise<void> {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 8080);

  await app.listen(port, '0.0.0.0');
  console.log(`DocFlow API listening on http://localhost:${port}/api (docs at /api/docs)`);
}

void main();
