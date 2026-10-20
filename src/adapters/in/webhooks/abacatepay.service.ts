import { createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from '../../../application/ports/services.js';
import {
  RegisterSaleInput,
  RegisterSaleResult,
  SaleService,
} from '../../../application/use-cases/sale.service.js';
import { TenantService } from '../../../application/use-cases/tenant.service.js';
import {
  InvoiceRefundResult,
  RefundService,
} from '../../../application/use-cases/refund.service.js';
import { DomainError } from '../../../domain/shared/domain-error.js';

/**
 * Chave pública fixa do AbacatePay para o HMAC do corpo (X-Webhook-Signature).
 * Prova integridade do payload; a origem é provada pelo `webhookSecret` da URL.
 */
export const ABACATEPAY_PUBLIC_HMAC_KEY =
  't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9';

/** Pagamentos que geram nota. Renovações de assinatura trazem um `checkout` com os itens, como o checkout avulso. */
const PAID_EVENTS = new Set([
  'billing.paid',
  'checkout.completed',
  'transparent.completed',
  'subscription.completed',
  'subscription.renewed',
]);
/**
 * Eventos em que o dinheiro volta ao cliente: as notas da venda devem ser canceladas.
 * `*.lost` = disputa (chargeback) perdida. `billing.refunded` (v1) não está na documentação oficial — tratado por precaução.
 */
const REFUND_EVENTS = new Set([
  'checkout.refunded',
  'transparent.refunded',
  'checkout.lost',
  'transparent.lost',
  'billing.refunded',
]);

/** Id da cobrança (= externalId da venda) em qualquer formato de payload. */
export function abacatePayChargeId(payload: Json): string | undefined {
  const d = payload?.data ?? {};
  const id = d.checkout?.id ?? d.transparent?.id ?? d.billing?.id;
  return id ? String(id) : undefined;
}

export const isAbacatePayRefund = (payload: Json): boolean =>
  REFUND_EVENTS.has(String(payload?.event ?? ''));

export type WebhookResult =
  | { status: 'ACCEPTED'; result: RegisterSaleResult }
  /** Venda guardada: produto ainda não cadastrado/sem tributação — vira nota quando ficar pronto. */
  | { status: 'HELD'; saleId: string; reasons: string[] }
  | { status: 'REFUNDED'; saleId: string; invoices: InvoiceRefundResult[] }
  | { status: 'IGNORED'; reason: string };

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function verifyAbacatePaySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY)
    .update(rawBody)
    .digest('base64');
  return safeEqual(expected, signature);
}

/** Converte o payload do AbacatePay (v1 billing.paid ou v2 checkout.completed) em uma venda. */
export function mapAbacatePayPayload(payload: Json): RegisterSaleInput | { ignored: string } {
  const event = String(payload?.event ?? '');
  if (!PAID_EVENTS.has(event)) return { ignored: `Evento ${event || '(vazio)'} não gera nota` };
  const data = payload.data ?? {};

  if (event === 'billing.paid') {
    const billing = data.billing;
    if (!billing?.products?.length)
      return { ignored: 'Pagamento sem produtos (ex.: PIX avulso) — emita via API' };
    const meta = billing.customer?.metadata ?? {};
    return {
      source: 'ABACATEPAY',
      externalId: String(billing.id),
      customer: {
        name: meta.name || undefined,
        email: meta.email || undefined,
        phone: meta.cellphone || undefined,
        taxId: meta.taxId || undefined,
      },
      items: billing.products.map((p: Json) => ({
        productExternalId: String(p.externalId),
        quantity: Number(p.quantity ?? 1),
        unitPriceCents: p.price === undefined ? undefined : Number(p.price),
      })),
      totalCents: Number(billing.paidAmount ?? billing.amount),
      rawPayload: payload,
    };
  }

  const checkout = data.checkout ?? data.transparent ?? data.billing;
  // Pix transparente não tem itens: quem gera o Pix informa o produto em metadata.productExternalId.
  // Sem isso (ex.: Pix de cobrança do açaínfe, cuja nota sai na nota mensal), não há nota.
  const pixProduct = checkout?.metadata?.productExternalId;
  const items: Json[] = checkout?.items?.length
    ? checkout.items
    : pixProduct
      ? [{ id: pixProduct, quantity: 1 }]
      : [];
  if (!items.length) return { ignored: 'Pagamento sem itens nem metadata.productExternalId' };
  const customer = data.customer ?? {};
  return {
    source: 'ABACATEPAY',
    externalId: String(checkout.id),
    customer: {
      externalId: customer.id ? String(customer.id) : undefined,
      name: customer.name || undefined,
      email: customer.email || undefined,
      phone: customer.cellphone || undefined,
      // taxId chega mascarado no v2 ("123.***.***-**"); createCustomer descarta valores mascarados.
      taxId: customer.taxId || undefined,
    },
    items: items.map((i: Json) => ({
      productExternalId: String(i.id),
      quantity: Number(i.quantity ?? 1),
    })),
    totalCents: Number(checkout.paidAmount ?? checkout.amount),
    rawPayload: payload,
  };
}

export class AbacatePayWebhookService {
  constructor(
    private readonly deps: {
      tenants: TenantService;
      sales: SaleService;
      refunds: RefundService;
      logger: Logger;
    }
  ) {}

  async handle(params: {
    tenantId: string;
    webhookSecret: string | undefined;
    signature: string | undefined;
    rawBody: Buffer;
    payload: Json;
  }): Promise<WebhookResult> {
    const tenant = await this.deps.tenants.get(params.tenantId).catch(() => null);
    const expected = tenant?.integrations.abacatepay?.webhookSecret;
    if (
      !tenant ||
      !expected ||
      !params.webhookSecret ||
      !safeEqual(expected, params.webhookSecret)
    ) {
      throw new DomainError('UNAUTHORIZED', 'webhookSecret inválido');
    }
    if (params.signature && !verifyAbacatePaySignature(params.rawBody, params.signature)) {
      throw new DomainError('UNAUTHORIZED', 'Assinatura X-Webhook-Signature inválida');
    }
    if (params.payload?.devMode && tenant.environment === 'PRODUCTION') {
      return { status: 'IGNORED', reason: 'Evento de devMode ignorado em produção' };
    }

    if (isAbacatePayRefund(params.payload)) {
      const externalId = abacatePayChargeId(params.payload);
      if (!externalId) return { status: 'IGNORED', reason: 'Estorno sem id da cobrança' };
      try {
        const { sale, invoices } = await this.deps.refunds.refundSale(
          tenant,
          { externalId, source: 'ABACATEPAY' },
          {
            requestedBy: 'ABACATEPAY',
            reasonCode: '2',
            reason: `Estorno do pagamento ${externalId} no AbacatePay`,
          }
        );
        return { status: 'REFUNDED', saleId: sale.id, invoices };
      } catch (error) {
        if (error instanceof DomainError && error.code === 'NOT_FOUND') {
          return { status: 'IGNORED', reason: `Venda ${externalId} não encontrada` };
        }
        throw error;
      }
    }

    const mapped = mapAbacatePayPayload(params.payload);
    if ('ignored' in mapped) return { status: 'IGNORED', reason: mapped.ignored };
    const result = await this.deps.sales.register(tenant, mapped, { holdIfNotReady: true });
    if (result.held) {
      return { status: 'HELD', saleId: result.sale.id, reasons: result.sale.held?.reasons ?? [] };
    }
    return { status: 'ACCEPTED', result };
  }
}
