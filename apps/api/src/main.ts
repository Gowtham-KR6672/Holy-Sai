import 'reflect-metadata';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { env } from './config/env';
import { validationError } from './common/errors';
import { workspacePathRewrite } from './tenancy/tenancy.middleware';

async function bootstrap() {
  const config = env();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false, rawBody: true });
  app.set('trust proxy', 1);
  // /api/w/<code>/… addresses (webhooks, public pages) are served as /api/… for that school.
  app.use(workspacePathRewrite);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  // strict: false — some pages post a bare JSON string (e.g. an id) as the body.
  app.useBodyParser('json', { limit: '25mb', strict: false });
  app.enableCors({ origin: config.webOrigins, credentials: true, exposedHeaders: ['Content-Disposition'] });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
      exceptionFactory: (errors) => validationError(errors),
    }),
  );
  app.enableShutdownHooks();
  await app.listen(config.port);
  Logger.log(`API listening on http://localhost:${config.port}/api`, 'Bootstrap');
}

void bootstrap();
