import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { CONTAINER } from './support.js';
import type { AuthedRequest } from './support.js';

export type AppRequest = AuthedRequest & { user?: User };

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Autenticação do app web (front no Replit). O BACKEND do app — nunca o navegador — chama a API com
 * `x-app-key` e repassa a identidade do usuário já autenticado pelo Replit Auth (Google):
 * `x-user-id` (id estável), `x-user-email` e, opcionalmente, `x-user-name`.
 */
@Injectable()
export class AppUserGuard implements CanActivate {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const expected = this.c.env.APP_API_KEY;
    const given = String(req.headers['x-app-key'] ?? '');
    if (!expected || !given || !safeEqual(expected, given)) {
      throw new DomainError('UNAUTHORIZED', 'x-app-key inválida');
    }
    const externalId = String(req.headers['x-user-id'] ?? '').trim();
    const email = String(req.headers['x-user-email'] ?? '').trim();
    if (!externalId || !email)
      throw new DomainError('UNAUTHORIZED', 'Informe x-user-id e x-user-email');
    const nameHeader = req.headers['x-user-name'];
    req.user = await this.c.accounts.identify({
      externalId,
      email,
      name: typeof nameHeader === 'string' ? decodeURIComponent(nameHeader) : undefined,
    });
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): User => {
  const user = ctx.switchToHttp().getRequest<AppRequest>().user;
  if (!user) throw new DomainError('UNAUTHORIZED', 'Não autenticado');
  return user;
});

const APP_HEADERS = [
  ApiHeader({
    name: 'x-app-key',
    required: true,
    description: 'Chave do backend do app (nunca no navegador)',
  }),
  ApiHeader({ name: 'x-user-id', required: true, description: 'Id do usuário no Replit Auth' }),
  ApiHeader({ name: 'x-user-email', required: true }),
  ApiHeader({ name: 'x-user-name', required: false, description: 'URL-encoded' }),
];

export const AppHeaders = (): ClassDecorator => (target) => {
  for (const d of APP_HEADERS) d(target);
};
