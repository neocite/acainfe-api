import {
  ArgumentsHost,
  CanActivate,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { DomainError, DomainErrorCode } from '../../../../domain/shared/domain-error.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';

export const CONTAINER = Symbol('CONTAINER');

export type AuthedRequest = FastifyRequest & { tenant?: Tenant; rawBody?: Buffer };

export function extractApiKey(headers: FastifyRequest['headers']): string | undefined {
  const header = headers['x-api-key'];
  if (typeof header === 'string' && header) return header;
  const auth = headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.tenant = await this.container.tenants.authenticate(extractApiKey(req.headers));
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const given = Buffer.from(String(req.headers['x-admin-key'] ?? ''));
    const expected = Buffer.from(this.container.env.ADMIN_API_KEY);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new DomainError('UNAUTHORIZED', 'x-admin-key inválida');
    }
    return true;
  }
}

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): Tenant => {
  const tenant = ctx.switchToHttp().getRequest<AuthedRequest>().tenant;
  if (!tenant) throw new DomainError('UNAUTHORIZED', 'Não autenticado');
  return tenant;
});

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw new DomainError('VALIDATION', 'Dados inválidos', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const STATUS: Record<DomainErrorCode, number> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  UNAUTHORIZED: 401,
  CERTIFICATE_INVALID: 422,
  CERTIFICATE_MISSING: 422,
  UNAVAILABLE: 503,
};

export const domainErrorStatus = (code: DomainErrorCode): number => STATUS[code] ?? 400;

@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly onUnexpected: (error: unknown) => void) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (exception instanceof DomainError) {
      void reply.status(domainErrorStatus(exception.code)).send({
        error: exception.code,
        message: exception.message,
        details: exception.details,
      });
      return;
    }
    if (exception instanceof HttpException) {
      void reply.status(exception.getStatus()).send({ error: 'HTTP', message: exception.message });
      return;
    }
    // Erros do Fastify/parsers com status 4xx (JSON inválido, corpo grande demais, tipo não suportado…).
    const status = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      void reply.status(status).send({
        error: 'BAD_REQUEST',
        message: exception instanceof Error ? exception.message : 'Requisição inválida',
      });
      return;
    }
    this.onUnexpected(exception);
    void reply.status(500).send({ error: 'INTERNAL', message: 'Erro interno' });
  }
}
