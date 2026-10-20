import { BillingPaymentGateway } from '../../../application/ports/services.js';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { ACAINFE_USER_AGENT } from '../registry/brasilapi-company-registry.js';

/** Pix para o açaínfe cobrar seus clientes, na conta AbacatePay do próprio açaínfe (POST /transparents/create). */
export class AbacatePayBillingGateway implements BillingPaymentGateway {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.abacatepay.com/v2',
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async createPix(input: {
    amountCents: number;
    description: string;
    expiresInSeconds: number;
    customer?: { name: string; email: string; taxId: string; cellphone: string };
    metadata: Record<string, string>;
  }) {
    const response = await this.fetchImpl(
      `${this.baseUrl.replace(/\/$/, '')}/transparents/create`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': ACAINFE_USER_AGENT,
        },
        body: JSON.stringify({
          method: 'PIX',
          data: {
            amount: input.amountCents,
            description: input.description.slice(0, 140),
            expiresIn: input.expiresInSeconds,
            ...(input.customer ? { customer: input.customer } : {}),
            metadata: input.metadata,
          },
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok || json.success === false || !json.data?.id) {
      throw DomainError.invalidState(
        `Não foi possível gerar o Pix (${json.error ?? `HTTP ${response.status}`})`
      );
    }
    return {
      providerId: String(json.data.id),
      copyPaste: String(json.data.brCode ?? ''),
      qrCodeImage: json.data.brCodeBase64 ? String(json.data.brCodeBase64) : undefined,
      expiresAt: json.data.expiresAt ? new Date(json.data.expiresAt) : undefined,
    };
  }
}
