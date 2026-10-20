import { isSellable, Product } from '../product/product.js';
import { taxProfileKey, TaxProfile } from '../product/tax-profile.js';
import { Sale } from '../sale/sale.js';
import { DomainError } from '../shared/domain-error.js';
import { formatBRL } from '../shared/money.js';
import { InvoiceItem } from './invoice.js';

export interface InvoiceDraft {
  taxProfile: TaxProfile;
  items: InvoiceItem[];
  amountCents: number;
  serviceDescription: string;
}

/**
 * Agrupa os itens da venda por perfil tributário. Cada grupo vira uma NFS-e,
 * pois o DPS aceita um único código de serviço / alíquota por nota.
 * Este é o diferencial frente a emissores que fixam um único código por empresa.
 */
export function splitSaleIntoInvoices(sale: Sale, products: Map<string, Product>): InvoiceDraft[] {
  const groups = new Map<string, InvoiceDraft>();
  for (const item of sale.items) {
    const product = products.get(item.productId);
    if (!product) throw DomainError.notFound('Produto', item.productId);
    if (!product.active)
      throw DomainError.validation(`Produto inativo: ${product.name}`, { productId: product.id });
    if (!isSellable(product)) {
      throw DomainError.validation(
        `Produto "${product.name}" aguarda a definição da tributação (código de serviço) pelo usuário`,
        { productId: product.id, reason: 'TAX_REVIEW_PENDING' }
      );
    }
    const key = taxProfileKey(product.taxProfile);
    const group =
      groups.get(key) ??
      ({
        taxProfile: product.taxProfile,
        items: [],
        amountCents: 0,
        serviceDescription: '',
      } as InvoiceDraft);
    group.items.push({
      productId: product.id,
      productName: product.name,
      description: item.description?.trim() || product.serviceDescription,
      quantity: item.quantity,
      totalCents: item.totalCents,
    });
    group.amountCents += item.totalCents;
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => ({ ...g, serviceDescription: describe(g.items) }));
}

function describe(items: InvoiceItem[]): string {
  if (items.length === 1 && items[0].quantity === 1) return items[0].description.slice(0, 2000);
  return items
    .map((i) => `${i.quantity}x ${i.description} - ${formatBRL(i.totalCents)}`)
    .join('\n')
    .slice(0, 2000);
}
