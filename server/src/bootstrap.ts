import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

/**
 * Builds the application without listening on a port, so the same wiring backs
 * both `npm run dev` (src/main.ts) and the Vercel function (api/index.js).
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Vercel serves `public/` from its CDN before a request reaches the function,
  // so this only matters locally — but it is what keeps `pnpm dev` serving the
  // same documentation page the deployment does.
  app.useStaticAssets(join(process.cwd(), 'public'));

  app.setGlobalPrefix('api');

  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableCors({
    origin: allowedOrigins(),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400,
  });

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('DocFlow API')
      .setDescription(
        'Document extraction, review, approval and delivery. Every endpoint outside /auth, /demo and /health is scoped to the organization encoded in the bearer token. Processing returns server-sent events rather than JSON, so the reading, the model output and any repair attempt can be watched as they happen.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  /*
   * The assets are pointed at the static output rather than left to the
   * module's own middleware, which serves them out of `node_modules` — a
   * directory the deployed function does not carry. `scripts/copy-swagger-assets.mjs`
   * puts them there during the build.
   */
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    customCssUrl: '/docs-assets/swagger-ui.css',
    customJs: ['/docs-assets/swagger-ui-bundle.js', '/docs-assets/swagger-ui-standalone-preset.js'],
    customfavIcon: '/docs-assets/favicon-32x32.png',
  });

  await app.init();
  return app;
}

/**
 * `*` would be rejected by browsers alongside credentials and would also let any
 * site drive the API with a stolen token, so origins are allow-listed.
 */
function allowedOrigins(): string[] | boolean {
  const configured = process.env.APP_CORS_ALLOWED_ORIGINS;

  if (!configured) {
    return ['http://localhost:3000'];
  }

  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.includes('*') ? true : origins;
}
