import type { BillingPayment } from '../../../../domain/billing/billing.js';

/**
 * Visão do Pix para o cliente (sem ids internos de cobrança). `paymentId` é estável: o mesmo Pix
 * pendente reaproveitado devolve o mesmo id. Pendente com prazo vencido aparece como EXPIRED.
 * PAID só vem da confirmação do gateway (webhook): é o sinal para o evento de compra no analytics.
 */
export function toPaymentView(p: BillingPayment, now: Date = new Date()) {
  const expired = p.status === 'PENDING' && p.expiresAt !== undefined && p.expiresAt <= now;
  return {
    id: p.id,
    paymentId: p.id,
    status: expired ? ('EXPIRED' as const) : p.status,
    currency: 'BRL' as const,
    amountCents: p.amountCents,
    paidAmountCents: p.status === 'PAID' ? (p.paidAmountCents ?? p.amountCents) : undefined,
    pixCopyPaste: p.pixCopyPaste,
    pixQrCodeImage: p.pixQrCodeImage,
    expiresAt: p.expiresAt,
    paidAt: p.paidAt,
  };
}
