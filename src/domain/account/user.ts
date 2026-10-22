import type { ActivationLog } from '../activation/activation.js';
import { DomainError } from '../shared/domain-error.js';
import { normalizeBrazilianPhone, normalizeEmail } from '../shared/document.js';

/** Pessoa que faz login no app (via Replit/Google) e administra uma ou mais empresas. */
export interface User {
  id: string;
  /** Id do usuário no provedor de login (ex.: id do Replit Auth). */
  externalId: string;
  email: string;
  name?: string;
  /** 55DDDNUMERO */
  whatsapp?: string;
  tenantIds: string[];
  /** Lembretes da régua de ativação já enviados (e o pedido para não receber mais). */
  activation?: ActivationLog;
  createdAt: Date;
  updatedAt: Date;
}

export function createUser(
  id: string,
  input: { externalId: string; email: string; name?: string },
  now: Date
): User {
  if (!input.externalId?.trim())
    throw DomainError.validation('externalId do usuário é obrigatório');
  return {
    id,
    externalId: input.externalId.trim(),
    email: normalizeEmail(input.email),
    name: input.name?.trim() || undefined,
    tenantIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function updateUserProfile(
  user: User,
  patch: { name?: string; whatsapp?: string },
  now: Date
): User {
  const name = patch.name === undefined ? user.name : patch.name.trim();
  if (patch.name !== undefined && !name) throw DomainError.validation('Informe seu nome');
  return {
    ...user,
    name,
    whatsapp:
      patch.whatsapp === undefined ? user.whatsapp : normalizeBrazilianPhone(patch.whatsapp),
    updatedAt: now,
  };
}
