import { DomainError } from '../shared/domain-error.js';
import { Cents } from '../shared/money.js';

/** Uma cobrança por NFS-e emitida com sucesso (idempotente por invoiceId). */
export interface BillingCharge {
  id: string;
  tenantId: string;
  invoiceId: string;
  /** Número da NFS-e — para o extrato. */
  nfseNumber?: string;
  amountCents: Cents;
  status: 'OPEN' | 'PAID' | 'WAIVED';
  createdAt: Date;
  paidAt?: Date;
  /** Pagamento que quitou (ou 'CREDIT' quando abatido de crédito). */
  settledBy?: string;
}

export type BillingStatus = 'OK' | 'BLOCKED';

/** Conta de cobrança da empresa. */
export interface BillingAccount {
  tenantId: string;
  status: BillingStatus;
  /** Saldo a favor (ex.: Pix mínimo de R$ 1,00 pago para um saldo de R$ 0,80). */
  creditCents: Cents;
  /** Preço negociado por nota; ausente = preço padrão vigente. */
  pricePerInvoiceCents?: Cents;
  blockedAt?: Date;
  lastReminderAt?: Date;
  updatedAt: Date;
}

/** Pix gerado para quitar o saldo em aberto. */
export interface BillingPayment {
  id: string;
  tenantId: string;
  amountCents: Cents;
  /** Cobranças que este pagamento quita. */
  chargeIds: string[];
  status: 'PENDING' | 'PAID' | 'EXPIRED';
  provider: 'ABACATEPAY' | 'MANUAL';
  providerId?: string;
  pixCopyPaste?: string;
  pixQrCodeImage?: string;
  expiresAt?: Date;
  createdAt: Date;
  paidAt?: Date;
  paidAmountCents?: Cents;
}

/** Uso do açaínfe por uma empresa num período: base da nota mensal consolidada. */
export interface BillingUsage {
  tenantId: string;
  /** Notas emitidas (canceladas depois também contam). */
  invoiceCount: number;
  totalCents: Cents;
}

/** Pix mínimo aceito pelo AbacatePay. */
export const MIN_PIX_CENTS = 100;

export function newAccount(tenantId: string, now: Date): BillingAccount {
  return { tenantId, status: 'OK', creditCents: 0, updatedAt: now };
}

export interface BillingSummary {
  status: BillingStatus;
  openCents: Cents;
  openCharges: number;
  creditCents: Cents;
  /** Valor a pagar agora (saldo − crédito, respeitando o Pix mínimo). */
  amountDueCents: Cents;
  oldestOpenAt?: Date;
  /** Data em que a emissão será pausada se o saldo não for pago. */
  blocksAt?: Date;
  overdue: boolean;
  pricePerInvoiceCents: Cents;
}

export function summarize(
  account: BillingAccount,
  openCharges: BillingCharge[],
  now: Date,
  graceDays: number,
  defaultPrice: Cents
): BillingSummary {
  const openCents = openCharges.reduce((s, c) => s + c.amountCents, 0);
  const oldest = openCharges.reduce<Date | undefined>(
    (min, c) => (!min || c.createdAt < min ? c.createdAt : min),
    undefined
  );
  const blocksAt = oldest ? new Date(oldest.getTime() + graceDays * 86_400_000) : undefined;
  const net = Math.max(openCents - account.creditCents, 0);
  return {
    status: account.status,
    openCents,
    openCharges: openCharges.length,
    creditCents: account.creditCents,
    amountDueCents: net === 0 ? 0 : Math.max(net, MIN_PIX_CENTS),
    oldestOpenAt: oldest,
    blocksAt,
    overdue: Boolean(blocksAt && blocksAt <= now),
    pricePerInvoiceCents: account.pricePerInvoiceCents ?? defaultPrice,
  };
}

/**
 * Aplica um valor pago às cobranças em aberto (mais antigas primeiro). O que sobrar vira crédito.
 * Retorna as cobranças quitadas e o novo crédito.
 */
export function applyPayment(
  openCharges: BillingCharge[],
  paidCents: Cents,
  creditCents: Cents
): { settled: BillingCharge[]; creditCents: Cents } {
  if (!Number.isInteger(paidCents) || paidCents < 0)
    throw DomainError.validation('Valor pago inválido');
  let available = paidCents + creditCents;
  const settled: BillingCharge[] = [];
  for (const charge of [...openCharges].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  )) {
    if (charge.amountCents > available) break;
    available -= charge.amountCents;
    settled.push(charge);
  }
  return { settled, creditCents: available };
}
