import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '../../domain/shared/domain-error.js';
import { Logo, MAX_LOGO_BYTES, validateLogo } from '../../domain/tenant/logo.js';
import { createTaxProfile, TaxProfile } from '../../domain/product/tax-profile.js';
import {
  createTenant,
  EXCLUSIVE_DPS_SERIES,
  planNumbering,
  Tenant,
  TenantInput,
  companyIssRateBps,
  ApiKeyRecord,
  apiKeyId,
  MAX_API_KEYS,
} from '../../domain/tenant/tenant.js';
import { LogoRepository, TenantRepository } from '../ports/repositories.js';
import { Clock, IdGenerator, RemoteFileFetcher } from '../ports/services.js';

export const hashApiKey = (apiKey: string): string =>
  createHash('sha256').update(apiKey).digest('hex');

const generateApiKey = (): string => `acai_${randomBytes(24).toString('base64url')}`;

/** Chave como o usuário vê na lista (sem o segredo). */
export interface ApiKeyView {
  id: string;
  label?: string;
  last4?: string;
  createdAt?: Date;
  createdVia?: ApiKeyRecord['createdVia'];
  lastUsedAt?: Date;
  /** Chave criada antes do registro de metadados: sem nome nem data (o final aparece após o 1º uso). */
  legacy: boolean;
}

/** Último uso é gravado no máximo uma vez por hora por chave. */
const TOUCH_INTERVAL_MS = 3_600_000;

export type TenantView = Omit<Tenant, 'apiKeyHashes' | 'apiKeys' | 'integrations'> & {
  integrations: { abacatepay: boolean; abacatepayConnectedViaApi: boolean };
  effectiveIssRateBps?: number;
};

export function toTenantView(tenant: Tenant): TenantView {
  const { apiKeyHashes: _hashes, apiKeys: _keys, integrations, ...rest } = tenant;
  return {
    ...rest,
    /** Alíquota de ISS usada nos produtos: a informada ou a estimada pelo Simples (2,01% = 201). */
    effectiveIssRateBps: companyIssRateBps(tenant),
    integrations: {
      abacatepay: Boolean(integrations.abacatepay),
      abacatepayConnectedViaApi: Boolean(integrations.abacatepay?.encryptedApiKey),
    },
  };
}

export type TenantPatch = Partial<
  Pick<
    Tenant,
    | 'legalName'
    | 'tradeName'
    | 'email'
    | 'phone'
    | 'address'
    | 'specialTaxRegime'
    | 'taxRegime'
    | 'environment'
    | 'municipalRegistration'
    | 'approximateTaxes'
    | 'culturalIncentive'
    | 'simplesNacionalTaxRateBps'
    | 'simplesNacionalApuration'
    | 'businessType'
    | 'issRateBps'
    | 'fiscalProvider'
  >
> & {
  notifications?: Partial<Tenant['notifications']>;
  /** Serviço padrão (sugestão para produtos importados); o taxProfile é validado. */
  defaultService?: {
    taxProfile: Partial<TaxProfile> & { nationalServiceCode: string };
    serviceDescription?: string;
  } | null;
};

export class TenantService {
  constructor(
    private readonly deps: {
      tenants: TenantRepository;
      logos: LogoRepository;
      fetcher: RemoteFileFetcher;
      clock: Clock;
      ids: IdGenerator;
    }
  ) {}

  async create(input: TenantInput): Promise<{ tenant: TenantView; apiKey: string }> {
    const apiKey = generateApiKey();
    // Cadastro pelo admin: a numeração é responsabilidade de quem cadastra (pode ajustar depois).
    const tenant = createTenant(
      this.deps.ids.next(),
      { numberingConfirmed: true, ...input },
      hashApiKey(apiKey),
      this.deps.clock.now()
    );
    tenant.apiKeys = [this.keyRecord(apiKey, 'ADMIN', 'Chave inicial')];
    if (await this.deps.tenants.findByCnpj(tenant.cnpj)) {
      throw new DomainError('CONFLICT', 'Já existe uma empresa cadastrada com este CNPJ', {
        cnpj: tenant.cnpj,
      });
    }
    await this.deps.tenants.create(tenant);
    return { tenant: toTenantView(tenant), apiKey };
  }

  async authenticate(apiKey: string | undefined): Promise<Tenant> {
    if (!apiKey) throw new DomainError('UNAUTHORIZED', 'API key ausente');
    const hash = hashApiKey(apiKey);
    const tenant = await this.deps.tenants.findByApiKeyHash(hash);
    if (!tenant) throw new DomainError('UNAUTHORIZED', 'API key inválida');
    const record = tenant.apiKeys?.find((k) => k.hash === hash);
    const now = this.deps.clock.now();
    // O último uso é informativo: falha ao gravar não bloqueia a requisição.
    if (!record) {
      // Chave antiga (só hash): no primeiro uso guardamos o final e o uso, para o usuário reconhecê-la.
      await this.deps.tenants
        .adoptApiKey(tenant.id, { hash, last4: apiKey.slice(-4), lastUsedAt: now })
        .catch(() => undefined);
    } else if (
      !record.lastUsedAt ||
      now.getTime() - record.lastUsedAt.getTime() > TOUCH_INTERVAL_MS
    ) {
      await this.deps.tenants.touchApiKey(tenant.id, hash, now).catch(() => undefined);
    }
    return tenant;
  }

  async get(tenantId: string): Promise<Tenant> {
    const tenant = await this.deps.tenants.findById(tenantId);
    if (!tenant) throw DomainError.notFound('Empresa', tenantId);
    return tenant;
  }

  async update(tenantId: string, patch: TenantPatch): Promise<TenantView> {
    const current = await this.get(tenantId);
    // Revalida reaproveitando a fábrica do domínio.
    const { defaultService, ...rest } = patch;
    const validated = createTenant(
      current.id,
      {
        ...current,
        ...rest,
        defaultService:
          defaultService === null
            ? undefined
            : defaultService
              ? {
                  serviceDescription: defaultService.serviceDescription,
                  taxProfile: createTaxProfile(defaultService.taxProfile),
                }
              : current.defaultService,
        notifications: { ...current.notifications, ...patch.notifications },
      },
      current.apiKeyHashes[0],
      current.createdAt
    );
    const updated: Tenant = {
      ...current,
      ...validated,
      // Campos controlados pelo sistema (status, dono, numeração) nunca vêm do patch.
      status: current.status,
      waitlist: current.waitlist,
      activatedAt: current.activatedAt,
      numberingConfirmedAt: current.numberingConfirmedAt,
      cnaes: current.cnaes,
      ownerUserIds: current.ownerUserIds,
      lastDpsNumber: current.lastDpsNumber,
      apiKeyHashes: current.apiKeyHashes,
      apiKeys: current.apiKeys,
      integrations: current.integrations,
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.tenants.update(updated);
    return toTenantView(updated);
  }

  async rotateApiKey(tenantId: string): Promise<{ apiKey: string }> {
    const tenant = await this.get(tenantId);
    const apiKey = generateApiKey();
    await this.deps.tenants.update({
      ...tenant,
      apiKeyHashes: [hashApiKey(apiKey)],
      apiKeys: [this.keyRecord(apiKey, 'API', 'Rotacionada')],
      updatedAt: this.deps.clock.now(),
    });
    return { apiKey };
  }

  /**
   * Numeração das notas (série e próximo número). Quem já emite por outro sistema recebe uma série
   * exclusiva do açaínfe, a menos que informe série/número — evita colisão com notas existentes.
   */
  async setNumbering(
    tenantId: string,
    input: { issuesElsewhere?: boolean; series?: string; nextNumber?: number }
  ): Promise<{ series: string; nextNumber: number }> {
    const tenant = await this.get(tenantId);
    const series =
      input.series ??
      (input.issuesElsewhere && Number(tenant.dpsSeries) !== Number(EXCLUSIVE_DPS_SERIES)
        ? EXCLUSIVE_DPS_SERIES
        : undefined);
    const plan = planNumbering(tenant, { series, nextNumber: input.nextNumber });
    await this.deps.tenants.setNumbering(
      tenantId,
      plan.series,
      plan.lastNumber,
      this.deps.clock.now()
    );
    return { series: plan.series, nextNumber: plan.lastNumber + 1 };
  }

  /** Emite uma API key adicional (ex.: para conectar o MCP) sem invalidar as existentes. Máx. 10. */
  /** Nova chave (as anteriores continuam valendo até serem revogadas; no máximo 10 ativas). */
  async issueApiKey(
    tenantId: string,
    options: { label?: string; via?: ApiKeyRecord['createdVia'] } = {}
  ): Promise<{ apiKey: string; key: ApiKeyView }> {
    const tenant = await this.get(tenantId);
    if (tenant.apiKeyHashes.length >= MAX_API_KEYS) {
      throw DomainError.invalidState(
        `Limite de ${MAX_API_KEYS} chaves ativas. Revogue uma chave que não usa mais antes de gerar outra.`
      );
    }
    const apiKey = generateApiKey();
    const record = this.keyRecord(apiKey, options.via ?? 'APP', options.label);
    await this.deps.tenants.update({
      ...tenant,
      apiKeyHashes: [...tenant.apiKeyHashes, record.hash],
      apiKeys: [...(tenant.apiKeys ?? []), record],
      updatedAt: this.deps.clock.now(),
    });
    return { apiKey, key: toApiKeyView(record.hash, record) };
  }

  /** Chaves ativas (sem o segredo), da mais nova para a mais antiga. */
  async listApiKeys(tenantId: string): Promise<ApiKeyView[]> {
    const tenant = await this.get(tenantId);
    return tenant.apiKeyHashes
      .map((hash) =>
        toApiKeyView(
          hash,
          tenant.apiKeys?.find((k) => k.hash === hash)
        )
      )
      .reverse();
  }

  /** Revoga uma chave: ela para de funcionar na hora (MCP e API). */
  async revokeApiKey(
    tenantId: string,
    keyId: string
  ): Promise<{ revoked: string; remaining: number }> {
    const tenant = await this.get(tenantId);
    const hash = tenant.apiKeyHashes.find((h) => apiKeyId(h) === keyId);
    if (!hash) throw DomainError.notFound('Chave', keyId);
    const apiKeyHashes = tenant.apiKeyHashes.filter((h) => h !== hash);
    await this.deps.tenants.update({
      ...tenant,
      apiKeyHashes,
      apiKeys: tenant.apiKeys?.filter((k) => k.hash !== hash),
      updatedAt: this.deps.clock.now(),
    });
    return { revoked: keyId, remaining: apiKeyHashes.length };
  }

  /** Revoga todas as chaves (ex.: suspeita de vazamento). Gere uma nova para voltar a usar o MCP. */
  async revokeAllApiKeys(tenantId: string): Promise<{ revoked: number }> {
    const tenant = await this.get(tenantId);
    await this.deps.tenants.update({
      ...tenant,
      apiKeyHashes: [],
      apiKeys: [],
      updatedAt: this.deps.clock.now(),
    });
    return { revoked: tenant.apiKeyHashes.length };
  }

  private keyRecord(apiKey: string, via: ApiKeyRecord['createdVia'], label?: string): ApiKeyRecord {
    const trimmed = label?.trim().slice(0, 60);
    return {
      hash: hashApiKey(apiKey),
      label: trimmed || undefined,
      last4: apiKey.slice(-4),
      createdAt: this.deps.clock.now(),
      createdVia: via,
    };
  }

  /** Gera o segredo usado na URL do webhook do AbacatePay. */
  async enableAbacatePay(
    tenantId: string,
    publicBaseUrl: string
  ): Promise<{ webhookUrl: string; webhookSecret: string }> {
    const tenant = await this.get(tenantId);
    const webhookSecret = randomBytes(24).toString('base64url');
    await this.deps.tenants.update({
      ...tenant,
      integrations: {
        ...tenant.integrations,
        abacatepay: { ...tenant.integrations.abacatepay, webhookSecret },
      },
      updatedAt: this.deps.clock.now(),
    });
    return {
      webhookUrl: `${publicBaseUrl.replace(/\/$/, '')}/v1/webhooks/abacatepay/${tenant.id}?webhookSecret=${webhookSecret}`,
      webhookSecret,
    };
  }

  /** Logo exibido no DANFSe (PDF). Aceita o arquivo ou uma URL https pública. */
  async setLogo(
    tenantId: string,
    source: { data?: Buffer; url?: string }
  ): Promise<{ contentType: Logo['contentType']; bytes: number }> {
    await this.get(tenantId);
    let data = source.data;
    if (!data && source.url) data = await this.deps.fetcher.fetch(source.url, MAX_LOGO_BYTES);
    if (!data)
      throw DomainError.validation('Envie a imagem do logo (arquivo, base64 ou URL https)');
    const logo = validateLogo(data);
    await this.deps.logos.save(tenantId, logo);
    return { contentType: logo.contentType, bytes: logo.data.length };
  }

  async getLogo(tenantId: string): Promise<Logo | null> {
    return this.deps.logos.find(tenantId);
  }

  async removeLogo(tenantId: string): Promise<void> {
    await this.deps.logos.delete(tenantId);
  }
}

function toApiKeyView(hash: string, record?: ApiKeyRecord): ApiKeyView {
  return record
    ? {
        id: apiKeyId(hash),
        label: record.label,
        last4: record.last4,
        createdAt: record.createdAt,
        createdVia: record.createdVia,
        lastUsedAt: record.lastUsedAt,
        legacy: !record.createdAt,
      }
    : { id: apiKeyId(hash), legacy: true };
}
