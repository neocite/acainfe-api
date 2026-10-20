import {
  GatewayCustomer,
  GatewayPaidCharge,
  GatewayProduct,
  PaymentGatewayAdmin,
} from '../../../application/ports/services.js';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { ACAINFE_USER_AGENT } from '../registry/brasilapi-company-registry.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Operações na conta AbacatePay do próprio usuário (API v2, Bearer).
 * Permissões necessárias na key: PRODUCT:READ e WEBHOOK:CREATE.
 */
export class AbacatePayAdminClient implements PaymentGatewayAdmin {
  constructor(
    private readonly baseUrl = 'https://api.abacatepay.com/v2',
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async call(
    apiKey: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    permission = 'PRODUCT:READ e WEBHOOK:CREATE'
  ): Promise<Json> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': ACAINFE_USER_AGENT,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => ({}))) as Json;
    // 422 (e não 401): a chave inválida é do AbacatePay, não a autenticação do app no açaínfe.
    if (response.status === 401) throw DomainError.validation('API key do AbacatePay inválida');
    if (response.status === 403) {
      throw new DomainError(
        'VALIDATION',
        `A API key do AbacatePay precisa da(s) permissão(ões) ${permission}`,
        {
          missingPermission: permission,
        }
      );
    }
    if (!response.ok || json.success === false) {
      throw DomainError.validation(`AbacatePay: ${json.error ?? `HTTP ${response.status}`}`);
    }
    return json;
  }

  async listProducts(apiKey: string): Promise<GatewayProduct[]> {
    const products: GatewayProduct[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = `limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const json = await this.call(apiKey, 'GET', `/products/list?${query}`);
      for (const p of (json.data ?? []) as Json[]) {
        products.push({
          id: String(p.id),
          externalId: p.externalId ? String(p.externalId) : undefined,
          name: String(p.name ?? p.id),
          description: p.description ? String(p.description) : undefined,
          priceCents: typeof p.price === 'number' ? p.price : undefined,
          recurring: Boolean(p.cycle),
        });
      }
      if (!json.pagination?.hasMore || !json.pagination?.next) break;
      after = String(json.pagination.next);
    }
    return products;
  }

  async createWebhook(
    apiKey: string,
    webhook: { name: string; endpoint: string; secret: string; events: string[] }
  ): Promise<{ id: string }> {
    const json = await this.call(apiKey, 'POST', '/webhooks/create', webhook);
    return { id: String(json.data?.id ?? '') };
  }

  /** Percorre todas as páginas de uma listagem (limit/after) do AbacatePay. */
  private async paginate(
    apiKey: string,
    path: string,
    query: Record<string, string>,
    permission: string
  ): Promise<Json[]> {
    const items: Json[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({ ...query, limit: '100', ...(after ? { after } : {}) });
      const json = await this.call(apiKey, 'GET', `${path}?${params}`, undefined, permission);
      items.push(...((json.data ?? []) as Json[]));
      if (!json.pagination?.hasMore || !json.pagination?.next) break;
      after = String(json.pagination.next);
    }
    return items;
  }

  async listCharges(apiKey: string, range: { from: Date; to: Date }): Promise<GatewayPaidCharge[]> {
    const query = {
      startDate: range.from.toISOString().slice(0, 10),
      endDate: range.to.toISOString().slice(0, 10),
    };
    const sources: [GatewayPaidCharge['kind'], string, string][] = [
      ['CHECKOUT', '/checkouts/list', 'CHECKOUT:READ'],
      ['TRANSPARENT', '/transparents/list', 'TRANSPARENT:READ'],
      ['SUBSCRIPTION', '/subscriptions/checkouts/list', 'SUBSCRIPTION:READ'],
    ];
    const charges: GatewayPaidCharge[] = [];
    for (const [kind, path, permission] of sources) {
      for (const c of await this.paginate(apiKey, path, query, permission)) {
        const status = String(c.status ?? '').toUpperCase();
        const mapped: GatewayPaidCharge['status'] | undefined = [
          'PAID',
          'APPROVED',
          'COMPLETED',
        ].includes(status)
          ? 'PAID'
          : ['REFUNDED', 'DISPUTED', 'LOST', 'CHARGEBACK'].includes(status)
            ? 'REFUNDED'
            : undefined;
        if (!mapped) continue; // pendente/expirada: não houve venda
        charges.push({
          id: String(c.id),
          kind,
          status: mapped,
          // A API não expõe a data do pagamento; updatedAt é o momento em que a cobrança mudou para paga.
          paidAt: new Date(String(c.updatedAt ?? c.createdAt)),
          amountCents: Number(c.paidAmount ?? c.amount ?? 0),
          items: Array.isArray(c.items)
            ? c.items.map((i: Json) => ({
                productExternalId: String(i.id),
                quantity: Number(i.quantity ?? 1),
              }))
            : [],
          customerId: c.customerId ? String(c.customerId) : undefined,
        });
      }
    }
    return charges;
  }

  async listCustomers(apiKey: string): Promise<GatewayCustomer[]> {
    try {
      return (await this.paginate(apiKey, '/customers/list', {}, 'CUSTOMER:READ')).map((c) => ({
        id: String(c.id),
        name: c.name ? String(c.name) : undefined,
        email: c.email ? String(c.email) : undefined,
        taxId: c.taxId ? String(c.taxId) : undefined,
        phone: c.cellphone ? String(c.cellphone) : undefined,
      }));
    } catch (error) {
      // Sem CUSTOMER:READ as notas saem sem tomador identificado (permitido); não bloqueia.
      if (error instanceof DomainError && error.details?.missingPermission) return [];
      throw error;
    }
  }
}
