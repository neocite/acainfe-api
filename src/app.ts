import 'reflect-metadata';
import multipart from '@fastify/multipart';
import { DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { McpController } from './adapters/in/mcp/mcp.controller.js';
import {
  AdminGuard,
  ApiKeyGuard,
  AppUserGuard,
  CONTAINER,
  ErrorFilter,
  HTTP_CONTROLLERS,
} from './adapters/in/http/index.js';
import type { Container } from './config/container.js';

@Module({})
class AppModule {
  static register(container: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [...HTTP_CONTROLLERS, McpController],
      providers: [
        { provide: CONTAINER, useValue: container },
        ApiKeyGuard,
        AdminGuard,
        AppUserGuard,
      ],
    };
  }
}

/** Monta a aplicação HTTP (REST + MCP) sobre um container já construído. */
export async function createApp(container: Container): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(container),
    new FastifyAdapter({ bodyLimit: 5 * 1024 * 1024, trustProxy: true }),
    { rawBody: true, logger: container.env.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'] }
  );
  // JSON tolerante a corpo vazio: POSTs sem dados (ex.: gerar chave do MCP) chegam com
  // Content-Type: application/json e body vazio — o Fastify recusaria com 400. Vazio vira {}.
  // O Nest mantém req.rawBody (usado na verificação de assinatura dos webhooks).
  app.useBodyParser('application/json', { bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => {
    const text = body.toString('utf8').trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = Object.assign(new Error('JSON inválido no corpo da requisição'), {
        statusCode: 400,
      });
      done(error, undefined);
    }
  });
  await app.register(multipart as never, { limits: { fileSize: 200 * 1024, files: 1 } });
  app.useGlobalFilters(
    new ErrorFilter((error) =>
      container.logger.error('Erro não tratado', {
        error: String(error),
        stack: (error as Error)?.stack,
      })
    )
  );
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('açaínfe API')
    .setDescription(
      'Emissão de NFS-e com tributação por produto. Também disponível via MCP em /mcp.'
    )
    .setVersion(container.env.APP_VERSION)
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'apiKey')
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
  return app;
}
