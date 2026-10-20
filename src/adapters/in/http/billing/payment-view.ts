import type { BillingPayment } from '../../../../domain/billing/billing.js';

/** Visão do Pix para o cliente (sem ids internos de cobrança). */
export function toPaymentView(p: BillingPayment) {
  return {
    id: p.id,
    status: p.status,
    amountCents: p.amountCents,
    pixCopyPaste: p.pixCopyPaste,
    pixQrCodeImage: p.pixQrCodeImage,
    expiresAt: p.expiresAt,
    paidAt: p.paidAt,
  };
}
