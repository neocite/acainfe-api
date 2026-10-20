import { DomainError } from '../shared/domain-error.js';
import { assertCents, Cents } from '../shared/money.js';
import { Customer } from './customer.js';

export type SaleSource = 'API' | 'MCP' | 'ABACATEPAY';

export interface SaleItem {
  productId: string;
  quantity: number;
  /** Valor total da linha (quantidade × unitário), em centavos. */
  totalCents: Cents;
  /** Sobrescreve a discriminação do produto, se informado. */
  description?: string;
}

export interface Sale {
  id: string;
  tenantId: string;
  source: SaleSource;
  /** Id da venda no sistema de origem — chave de idempotência junto com tenantId+source. */
  externalId: string;
  customer: Customer;
  items: SaleItem[];
  totalCents: Cents;
  invoiceIds: string[];
  /** Ambiente em que a venda foi registrada: homologação e produção não se misturam (idempotência por ambiente). */
  environment?: 'PRODUCTION' | 'HOMOLOGATION';
  /** Cliente cadastrado associado (tomador). */
  customerId?: string;
  /**
   * Venda retida: chegou do gateway com produto não cadastrado ou sem tributação confirmada.
   * As notas são geradas automaticamente quando os produtos ficarem prontos (nenhuma venda é perdida).
   */
  held?: { since: Date; reasons: string[]; input: unknown };
  /** Estorno solicitado: todas as notas da venda devem ser canceladas (ou não emitidas). */
  refund?: SaleRefund;
  rawPayload?: unknown;
  createdAt: Date;
}

export interface SaleRefund {
  requestedAt: Date;
  /** cMotivo do evento de cancelamento: 1 = erro na emissão, 2 = serviço não prestado, 9 = outros. */
  reasonCode: '1' | '2' | '9';
  reason: string;
  source: SaleSource;
}

export function requestRefund(
  sale: Sale,
  params: { reasonCode?: '1' | '2' | '9'; reason?: string; source: SaleSource },
  now: Date
): Sale {
  if (sale.refund) return sale; // idempotente: gateways reenviam o evento de estorno
  const reason = (params.reason ?? 'Estorno do pagamento: serviço não prestado').trim();
  if (reason.length < 15 || reason.length > 255) {
    throw DomainError.validation('A justificativa do estorno deve ter de 15 a 255 caracteres');
  }
  return {
    ...sale,
    refund: {
      requestedAt: now,
      reasonCode: params.reasonCode ?? '2',
      reason,
      source: params.source,
    },
  };
}

export function createSale(
  params: Omit<Sale, 'totalCents' | 'invoiceIds' | 'refund' | 'held'>
): Sale {
  if (!params.externalId?.trim()) throw DomainError.validation('externalId é obrigatório');
  if (!params.items.length) throw DomainError.validation('A venda precisa de ao menos um item');
  for (const item of params.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw DomainError.validation('quantity deve ser um inteiro maior que zero', {
        productId: item.productId,
      });
    }
    assertCents(item.totalCents, 'totalCents');
  }
  const totalCents = params.items.reduce((sum, i) => sum + i.totalCents, 0);
  if (totalCents <= 0) throw DomainError.validation('O total da venda deve ser maior que zero');
  return { ...params, externalId: params.externalId.trim(), totalCents, invoiceIds: [] };
}

export function createHeldSale(
  params: Pick<
    Sale,
    | 'id'
    | 'tenantId'
    | 'source'
    | 'externalId'
    | 'customer'
    | 'rawPayload'
    | 'createdAt'
    | 'environment'
  > & {
    totalCents?: number;
    reasons: string[];
    input: unknown;
  }
): Sale {
  if (!params.externalId?.trim()) throw DomainError.validation('externalId é obrigatório');
  return {
    id: params.id,
    tenantId: params.tenantId,
    environment: params.environment,
    source: params.source,
    externalId: params.externalId.trim(),
    customer: params.customer,
    items: [],
    totalCents: params.totalCents ?? 0,
    invoiceIds: [],
    held: { since: params.createdAt, reasons: params.reasons, input: params.input },
    rawPayload: params.rawPayload,
    createdAt: params.createdAt,
  };
}
