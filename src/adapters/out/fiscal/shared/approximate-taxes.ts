import { Invoice } from '../../../../domain/invoice/invoice.js';
import { applyBps, centsToPlainDecimal, formatBps } from '../../../../domain/shared/money.js';
import { approximateTaxRateBps, Tenant } from '../../../../domain/tenant/tenant.js';

/**
 * Acrescenta à discriminação o texto de tributos aproximados (Lei 12.741), se a empresa configurou
 * o modelo. Tags: [ValorTributos] (R$) e [PercentualTributos] (%). Usado no nacional e no Ginfes.
 */
export function withApproximateTaxes(invoice: Invoice, tenant: Tenant): string {
  const template = tenant.approximateTaxes?.descriptionTemplate;
  const rate = approximateTaxRateBps(invoice.taxProfile, tenant);
  if (!template || rate === undefined) return invoice.serviceDescription;
  const value = centsToPlainDecimal(applyBps(invoice.amountCents, rate)).replace('.', ',');
  const text = template
    .replace(/\[ValorTributos\]/g, value)
    .replace(/\[PercentualTributos\]/g, formatBps(rate));
  return `${invoice.serviceDescription}\n${text}`;
}
