import { DomainError } from '../shared/domain-error.js';

/** Envio mensal ao contador (um por empresa e mês — garante idempotência do job). */
export interface AccountantReport {
  id: string;
  tenantId: string;
  /** Mês de referência AAAA-MM (horário de Brasília). */
  period: string;
  status: 'SENT' | 'FAILED';
  invoiceCount: number;
  totalCents: number;
  channels: ('EMAIL' | 'WHATSAPP')[];
  trigger: 'SCHEDULE' | 'MANUAL';
  error?: string;
  sentAt: Date;
}

const BRT_OFFSET_MS = -3 * 3_600_000;

/** Mês anterior à data (em Brasília), formato AAAA-MM. */
export function previousPeriod(now: Date): string {
  const brt = new Date(now.getTime() + BRT_OFFSET_MS);
  const year = brt.getUTCMonth() === 0 ? brt.getUTCFullYear() - 1 : brt.getUTCFullYear();
  const month = brt.getUTCMonth() === 0 ? 12 : brt.getUTCMonth();
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Dia do mês em Brasília. */
export const brtDayOfMonth = (now: Date): number =>
  new Date(now.getTime() + BRT_OFFSET_MS).getUTCDate();

/** Intervalo [início, fim) do mês em UTC, considerando o fuso de Brasília. */
export function periodRange(period: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12)
    throw DomainError.validation('period deve estar no formato AAAA-MM');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const from = new Date(Date.UTC(year, month - 1, 1) - BRT_OFFSET_MS);
  const to = new Date(
    Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) - BRT_OFFSET_MS
  );
  return { from, to };
}
