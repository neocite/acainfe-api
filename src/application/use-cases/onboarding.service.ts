import { randomBytes } from 'node:crypto';
import { User } from '../../domain/account/user.js';
import { assertCertificateUsable } from '../../domain/certificate/certificate.js';
import {
  createImportedProduct,
  looksLikeTestProduct,
  normalizeProductName,
  Product,
  productExternalIds,
} from '../../domain/product/product.js';
import { BusinessType, FISCAL_PROFILES } from '../../domain/product/fiscal-profiles.js';
import { ProductService } from './product.service.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import {
  Availability,
  coversRegime,
  createCoverage,
  evaluateAvailability,
} from '../../domain/tenant/coverage.js';
import {
  activateTenant,
  companyFiscalProfile,
  companyIssRateBps,
  createTenant,
  FiscalSystem,
  Readiness,
  TaxRegime,
  Tenant,
  tenantReadiness,
} from '../../domain/tenant/tenant.js';
import {
  CoverageRepository,
  ProductRepository,
  TenantRepository,
  UserRepository,
} from '../ports/repositories.js';
import {
  CertificateParser,
  Clock,
  CompanyInfo,
  CompanyRegistry,
  EmailSender,
  IdGenerator,
  Logger,
  PaymentGatewayAdmin,
  SecretCipher,
  WhatsappSender,
} from '../ports/services.js';
import { AccountService } from './account.service.js';
import { CertificateService } from './certificate.service.js';
import { SaleService } from './sale.service.js';
import { PastSalesService } from './past-sales.service.js';
import { PastSalesPeriodSummary } from '../../domain/backfill/past-sale.js';
import { ApiKeyView, TenantService, TenantView, toTenantView } from './tenant.service.js';

export const ABACATEPAY_EVENTS = [
  'checkout.completed',
  'checkout.refunded',
  'checkout.lost',
  'transparent.completed',
  'transparent.refunded',
  'transparent.lost',
  'subscription.renewed',
];

export interface CompanyStatus {
  tenant: TenantView;
  availability: Availability;
  readiness: Readiness;
  pendingTaxReview: number;
  /** Certificado A1 ativo (sem material sensível): validade para o app exibir. */
  certificate: CompanyCertificateView;
  /** Por onde a nota é emitida (definido pela prefeitura; só leitura para o cliente). */
  emission: EmissionView;
  abacatepay: AbacatePayIntegrationView;
}

export interface AbacatePayIntegrationView {
  connected: boolean;
  connectedAt?: Date;
  webhookEndpoint?: string;
  /** false = o webhook aponta para outra URL (recrie); null = não sabemos (conectado antes do registro). */
  webhookUpToDate: boolean | null;
  /** Produto da nota quando o pagamento não informa o produto. decided=false: ainda não perguntado. */
  defaultProduct?: { decided: boolean; productId?: string };
}

export interface EmissionView {
  system: FiscalSystem;
  systemLabel: string;
  environment: 'PRODUCTION' | 'HOMOLOGATION';
  /** Modo piloto: cada nota espera aprovação antes de ir à prefeitura. */
  approvalRequired: boolean;
}

export const FISCAL_SYSTEM_LABEL: Record<FiscalSystem, string> = {
  NACIONAL: 'Emissor Nacional da NFS-e (Receita Federal)',
  GINFES: 'Ginfes, sistema próprio da prefeitura',
};

export interface CompanyCertificateView {
  present: boolean;
  /** Fim da validade (notAfter). */
  expiresAt?: Date;
  validFrom?: Date;
  daysUntilExpiry?: number;
  expiringSoon?: boolean;
  expired?: boolean;
  subjectName?: string;
  cnpj?: string;
  issuer?: string;
}

function regimeFrom(info: CompanyInfo): TaxRegime {
  if (info.mei) return 'MEI';
  if (info.simplesNacional) return 'SIMPLES_NACIONAL';
  // A Receita não informa Presumido vs Real nos dados públicos; o usuário pode corrigir depois.
  return 'LUCRO_PRESUMIDO';
}

/**
 * Onboarding self-service (app web): certificado → dados da Receita → cobertura do município
 * (pronto ou lista de espera) → dados complementares → AbacatePay → API key do MCP.
 */
export class OnboardingService {
  constructor(
    private readonly deps: {
      accounts: AccountService;
      tenantService: TenantService;
      certificates: CertificateService;
      sales: SaleService;
      tenants: TenantRepository;
      users: UserRepository;
      coverage: CoverageRepository;
      products: ProductRepository;
      parser: CertificateParser;
      registry: CompanyRegistry;
      gateway: PaymentGatewayAdmin;
      cipher: SecretCipher;
      email: EmailSender;
      whatsapp: WhatsappSender;
      clock: Clock;
      ids: IdGenerator;
      logger: Logger;
      publicBaseUrl?: string;
      pastSales?: PastSalesService;
      /** Consulta da alíquota municipal (ADN) ao definir o perfil fiscal. */
      productService?: ProductService;
      /** Por onde a empresa emite (regra do município ou escolha do admin). Padrão: nacional. */
      fiscalSystemOf?: (tenant: Tenant) => FiscalSystem;
      /** Integração em modo piloto: cada nota espera aprovação. */
      approvalRequired?: (tenant: Tenant) => boolean;
    }
  ) {}

  /** Etapa do certificado: descobre o CNPJ, consulta a Receita e cria (ou vincula) a empresa. */
  async submitCertificate(
    user: User,
    pfx: Buffer,
    password: string
  ): Promise<CompanyStatus & { company: CompanyInfo }> {
    if (!pfx?.length) throw DomainError.validation('Envie o arquivo do certificado (.pfx)');
    const meta = this.deps.parser.parse(pfx, password);
    if (!meta.cnpj) {
      throw new DomainError(
        'CERTIFICATE_INVALID',
        'Este certificado não é um e-CNPJ (não encontramos o CNPJ nele)'
      );
    }
    const now = this.deps.clock.now();
    assertCertificateUsable(meta, meta.cnpj, now);

    const company = await this.deps.registry.lookup(meta.cnpj);
    if (!company)
      throw DomainError.validation(`CNPJ ${meta.cnpj} não encontrado na Receita Federal`);
    if (!company.active) {
      throw DomainError.validation(
        `O CNPJ está com situação "${company.situation}" na Receita; só empresas ativas podem emitir`
      );
    }

    let tenant = await this.deps.tenants.findByCnpj(meta.cnpj);
    if (tenant) {
      // Quem tem o certificado A1 controla o CNPJ: pode administrar a empresa já cadastrada.
      if (!tenant.ownerUserIds.includes(user.id)) {
        tenant = { ...tenant, ownerUserIds: [...tenant.ownerUserIds, user.id], updatedAt: now };
        await this.deps.tenants.update(tenant);
      }
    } else {
      const regime = regimeFrom(company);
      const availability = evaluateAvailability(
        await this.deps.coverage.get(company.cityCode),
        regime,
        `${company.cityName}/${company.uf}`
      );
      tenant = createTenant(
        this.deps.ids.next(),
        {
          cnpj: meta.cnpj,
          legalName: company.legalName,
          tradeName: company.tradeName,
          cityCode: company.cityCode,
          cityName: company.cityName,
          uf: company.uf,
          taxRegime: regime,
          status: availability.status === 'READY' ? 'ACTIVE' : 'WAITLIST',
          waitlistReason: availability.status === 'WAITLIST' ? availability.reason : undefined,
          cnaes: company.cnaes,
          ownerUserIds: [user.id],
          email: user.email,
          phone: user.whatsapp,
          address: company.address && { ...company.address, cityCode: company.cityCode },
          // Cliente do app emite de verdade; homologação é só para testes internos (admin).
          environment: 'PRODUCTION',
        },
        undefined,
        now
      );
      await this.deps.tenants.create(tenant);
    }
    await this.deps.accounts.linkTenant(user, tenant.id);
    await this.deps.certificates.upload(tenant, pfx, password);
    return { ...(await this.status(tenant)), company };
  }

  /**
   * Dados que nenhuma fonte pública fornece: o que a empresa vende (perfil fiscal), numeração,
   * inscrição municipal e alíquotas.
   */
  async completeCompany(
    tenant: Tenant,
    patch: {
      /** O que você vende? Define a tributação padrão dos produtos. */
      businessType?: BusinessType;
      /** Tributos aproximados (Lei 12.741): percentual (IBPT) e texto da nota. */
      approximateTaxes?: { rateBps?: number; descriptionTemplate?: string; source?: string };
      /** Alíquota de ISS (pontos-base): só é pedida quando a prefeitura não publica e não dá para calcular. */
      issRateBps?: number;
      municipalRegistration?: string;
      simplesNacionalTaxRateBps?: number;
      taxRegime?: TaxRegime;
      tradeName?: string;
      /** Já emite NFS-e por outro sistema? Sim → série exclusiva do açaínfe (ou a informada). */
      issuesElsewhere?: boolean;
      dpsSeries?: string;
      nextDpsNumber?: number;
    }
  ): Promise<CompanyStatus> {
    const { issuesElsewhere, dpsSeries, nextDpsNumber, ...companyPatch } = patch;
    await this.deps.tenantService.update(tenant.id, companyPatch);
    if (issuesElsewhere !== undefined || dpsSeries !== undefined || nextDpsNumber !== undefined) {
      await this.deps.tenantService.setNumbering(tenant.id, {
        issuesElsewhere,
        series: dpsSeries,
        nextNumber: nextDpsNumber,
      });
    }
    let updated = (await this.deps.tenants.findById(tenant.id))!;
    if (patch.taxRegime && patch.taxRegime !== tenant.taxRegime) {
      // Regime mudou: reavalia a cobertura (ex.: corrigiu de Presumido para Simples).
      const availability = evaluateAvailability(
        await this.deps.coverage.get(updated.cityCode),
        updated.taxRegime,
        `${updated.cityName ?? updated.cityCode}/${updated.uf ?? ''}`
      );
      updated =
        availability.status === 'READY'
          ? activateTenant(updated, this.deps.clock.now())
          : {
              ...updated,
              status: 'WAITLIST',
              waitlist: { reason: availability.reason, since: this.deps.clock.now() },
            };
      await this.deps.tenants.update(updated);
    }
    if (patch.businessType || patch.issRateBps !== undefined || patch.taxRegime) {
      updated = await this.applyFiscalProfile(updated);
    }
    return this.status(updated);
  }

  /**
   * Aplica o perfil fiscal da empresa: descobre a alíquota de ISS (informada → calculada pelo Simples
   * → publicada pela prefeitura) e define a tributação dos produtos que ainda aguardam revisão.
   * Perfil validado confirma direto; perfil ainda não validado fica como sugestão para o usuário.
   */
  private async applyFiscalProfile(tenant: Tenant): Promise<Tenant> {
    let current = tenant;
    const definition = current.businessType && FISCAL_PROFILES[current.businessType];
    if (!definition) return current;
    if (companyIssRateBps(current) === undefined && current.taxRegime !== 'MEI') {
      const rate = await this.municipalIssRate(current, definition.taxProfile.nationalServiceCode);
      if (rate !== undefined) {
        current = { ...current, issRateBps: rate, updatedAt: this.deps.clock.now() };
        await this.deps.tenants.update(current);
      }
    }
    const company = companyFiscalProfile(current)!;
    const pending = await this.deps.products.list(current.id, {
      pendingTaxReview: true,
      pageSize: 100,
    });
    for (const product of pending.items) {
      await this.deps.products.update(this.withProfile(product, company));
    }
    return current;
  }

  private withProfile(
    product: Product,
    company: NonNullable<ReturnType<typeof companyFiscalProfile>>
  ): Product {
    const now = this.deps.clock.now();
    if (!company.definition.validated) {
      return { ...product, suggestedTaxProfile: company.taxProfile, updatedAt: now };
    }
    return {
      ...product,
      taxProfile: company.taxProfile,
      taxStatus: 'CONFIRMED',
      taxConfirmation: {
        at: now,
        via: 'PROFILE',
        note: `Perfil fiscal padrão: ${company.definition.label}`,
      },
      suggestedTaxProfile: undefined,
      updatedAt: now,
    };
  }

  /** Alíquota publicada pela prefeitura (ADN). Indisponível → undefined (o app pergunta ao usuário). */
  private async municipalIssRate(tenant: Tenant, code: string): Promise<number | undefined> {
    if (!this.deps.productService) return undefined;
    try {
      const params = await this.deps.productService.municipalParams(tenant, code);
      const rate = params?.issRateBps;
      return rate !== undefined && rate >= 200 && rate <= 500 ? rate : undefined;
    } catch (error) {
      this.deps.logger.warn('Alíquota municipal indisponível', {
        tenantId: tenant.id,
        error: String(error),
      });
      return undefined;
    }
  }

  async status(tenant: Tenant): Promise<CompanyStatus> {
    const cert = await this.deps.certificates.status(tenant.id);
    const system = this.deps.fiscalSystemOf?.(tenant) ?? 'NACIONAL';
    const availability: Availability =
      tenant.status === 'ACTIVE'
        ? { status: 'READY' }
        : { status: 'WAITLIST', reason: tenant.waitlist?.reason ?? '' };
    const pending = await this.deps.products.list(tenant.id, {
      pendingTaxReview: true,
      pageSize: 1,
    });
    return {
      tenant: toTenantView(tenant),
      availability,
      readiness: tenantReadiness(tenant, Boolean(cert.present && !cert.expired), {
        municipalRegistrationRequired: system === 'GINFES',
      }),
      abacatepay: this.abacatepayView(tenant),
      emission: {
        system,
        systemLabel: FISCAL_SYSTEM_LABEL[system],
        environment: tenant.environment,
        approvalRequired: this.deps.approvalRequired?.(tenant) ?? false,
      },
      pendingTaxReview: pending.total,
      certificate: cert.present
        ? {
            present: true,
            expiresAt: cert.metadata?.notAfter,
            validFrom: cert.metadata?.notBefore,
            daysUntilExpiry: cert.daysUntilExpiry,
            expiringSoon: cert.expiringSoon,
            expired: cert.expired,
            subjectName: cert.metadata?.subjectName,
            cnpj: cert.metadata?.cnpj,
            issuer: cert.metadata?.issuer,
          }
        : { present: false },
    };
  }

  private abacatepayView(tenant: Tenant): AbacatePayIntegrationView {
    const a = tenant.integrations.abacatepay;
    if (!a) return { connected: false, webhookUpToDate: null };
    const expected = this.deps.publicBaseUrl
      ? `${this.deps.publicBaseUrl.replace(/\/$/, '')}/v1/webhooks/abacatepay/${tenant.id}`
      : undefined;
    return {
      connected: true,
      connectedAt: a.connectedAt,
      webhookEndpoint: a.webhookEndpoint,
      webhookUpToDate: a.webhookEndpoint && expected ? a.webhookEndpoint === expected : null,
      defaultProduct: {
        decided: Boolean(a.defaultProductDecidedAt),
        productId: a.defaultProductId,
      },
    };
  }

  /**
   * Produto que vai na nota quando o pagamento não informa o produto (Pix transparente sem itens e sem
   * metadata.productExternalId). null = nenhum: esses pagamentos não geram nota.
   */
  async setDefaultProduct(
    tenant: Tenant,
    productId: string | null
  ): Promise<AbacatePayIntegrationView> {
    const current = (await this.deps.tenants.findById(tenant.id))!;
    if (!current.integrations.abacatepay)
      throw DomainError.invalidState('Conecte o AbacatePay antes de escolher o produto padrão');
    if (productId) {
      const product = await this.deps.products.findById(tenant.id, productId);
      if (!product) throw DomainError.notFound('Produto', productId);
      if (!product.active) throw DomainError.validation(`Produto inativo: ${product.name}`);
    }
    const now = this.deps.clock.now();
    const updated: Tenant = {
      ...current,
      integrations: {
        ...current.integrations,
        abacatepay: {
          ...current.integrations.abacatepay,
          defaultProductId: productId ?? undefined,
          defaultProductDecidedAt: now,
        },
      },
      updatedAt: now,
    };
    await this.deps.tenants.update(updated);
    return this.abacatepayView(updated);
  }

  /**
   * Conecta o AbacatePay com a key do usuário: cria o webhook automaticamente e importa o catálogo.
   * Produtos importados ficam aguardando o usuário definir a tributação (via MCP).
   */
  async connectAbacatePay(
    tenant: Tenant,
    apiKey: string,
    /** Busca de pagamentos antigos sem nota (só prévia). Padrão: últimos 3 meses. */
    options: { scanPastSales?: boolean; monthsBack?: number } = {}
  ): Promise<{
    webhookId: string;
    imported: number;
    alreadyExisting: number;
    pendingTaxReview: Product[];
    /** Importados já com a tributação do perfil fiscal validado da empresa. */
    confirmedByProfile: Product[];
    /** Produtos com cara de teste ("teste", "test", "demo"…) que não foram importados. */
    skippedTestProducts: string[];
    /** Produtos com o mesmo nome de outro: unificados (o id do AbacatePay vira alias). */
    mergedDuplicates: { name: string; externalId: string; productId: string }[];
    /** Prévia das vendas pagas antes do açaínfe (ou aviso, se a key não tiver permissão de leitura). */
    pastSales?: { periods: PastSalesPeriodSummary[] } | { warning: string };
    /**
     * Pergunta do onboarding: qual produto vai na nota quando o pagamento não informa o produto?
     * Com um produto só, ele vem sugerido; o usuário confirma (ou escolhe "nenhum") em setDefaultProduct.
     */
    defaultProduct: {
      decided: boolean;
      productId?: string;
      suggestedProductId?: string;
      options: { id: string; name: string }[];
    };
  }> {
    if (tenant.status !== 'ACTIVE') {
      throw DomainError.invalidState(
        'Conecte o AbacatePay quando sua empresa sair da lista de espera'
      );
    }
    if (!this.deps.publicBaseUrl)
      throw DomainError.validation('PUBLIC_BASE_URL não configurada no servidor');
    const key = apiKey?.trim();
    if (!key) throw DomainError.validation('Informe a API key do AbacatePay');

    const catalog = await this.deps.gateway.listProducts(key);
    const connected = tenant.integrations.abacatepay;
    let webhookId: string;
    let webhookSecret: string;
    let webhookEndpoint: string | undefined;
    if (connected?.webhookId) {
      // Reconexão (ex.: trocar a key por uma com mais permissões): NÃO cria outro webhook nem troca o
      // segredo — isso faria o webhook já cadastrado no AbacatePay ser rejeitado.
      // Para apontar para outra URL, use recreateAbacatePayWebhook.
      webhookId = connected.webhookId;
      webhookSecret = connected.webhookSecret;
      webhookEndpoint = connected.webhookEndpoint;
    } else {
      const enabled = await this.deps.tenantService.enableAbacatePay(
        tenant.id,
        this.deps.publicBaseUrl
      );
      const webhook = await this.deps.gateway.createWebhook(key, {
        name: 'açaínfe — emissão de NFS-e',
        endpoint: enabled.webhookUrl.split('?')[0],
        secret: enabled.webhookSecret,
        events: ABACATEPAY_EVENTS,
      });
      webhookId = webhook.id;
      webhookSecret = enabled.webhookSecret;
      webhookEndpoint = enabled.webhookUrl.split('?')[0];
    }

    const current = (await this.deps.tenants.findById(tenant.id))!;
    const updatedTenant = {
      ...current,
      integrations: {
        ...current.integrations,
        abacatepay: {
          ...current.integrations.abacatepay,
          webhookSecret,
          encryptedApiKey: this.deps.cipher.encrypt(Buffer.from(key, 'utf8')),
          webhookId,
          webhookEndpoint,
          connectedAt: connected?.connectedAt ?? this.deps.clock.now(),
        },
      },
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.tenants.update(updatedTenant);

    // Itens do checkout referenciam o id do produto no AbacatePay: ele vira o externalId local.
    const known = await this.deps.products.findManyByExternalIds(
      tenant.id,
      catalog.map((p) => p.id)
    );
    const existing = new Set(known.flatMap(productExternalIds));
    // Mesmo nome = mesmo produto (ex.: dois "Kero Avaliar" no AbacatePay): vira um só, com aliases.
    const byName = new Map<string, Product>();
    for (const p of (await this.deps.products.list(tenant.id, { pageSize: 100 })).items) {
      byName.set(normalizeProductName(p.name), p);
    }
    const company = companyFiscalProfile(updatedTenant);
    const created: Product[] = [];
    const skippedTestProducts: string[] = [];
    const mergedDuplicates: { name: string; externalId: string; productId: string }[] = [];
    for (const item of catalog.filter((p) => !existing.has(p.id))) {
      if (looksLikeTestProduct(item.name)) {
        skippedTestProducts.push(item.name);
        continue;
      }
      const twin = byName.get(normalizeProductName(item.name));
      if (twin) {
        const merged: Product = {
          ...twin,
          aliasExternalIds: [...(twin.aliasExternalIds ?? []), item.id],
          updatedAt: this.deps.clock.now(),
        };
        await this.deps.products.update(merged);
        byName.set(normalizeProductName(item.name), merged);
        mergedDuplicates.push({ name: item.name, externalId: item.id, productId: twin.id });
        continue;
      }
      let product = createImportedProduct(
        this.deps.ids.next(),
        tenant.id,
        {
          externalId: item.id,
          name: item.name,
          description: item.description,
          priceCents: item.priceCents,
          // Sem perfil fiscal: sugestão do serviço padrão; o usuário confirma produto a produto.
          suggestedTaxProfile: current.defaultService?.taxProfile,
        },
        this.deps.clock.now()
      );
      if (company) product = this.withProfile(product, company);
      await this.deps.products.create(product);
      byName.set(normalizeProductName(item.name), product);
      created.push(product);
    }
    // Já mostra as vendas pagas sem nota (oportunidade de emitir), sem emitir nada.
    let pastSales: { periods: PastSalesPeriodSummary[] } | { warning: string } | undefined;
    if (this.deps.pastSales && options.scanPastSales !== false) {
      try {
        pastSales = {
          periods: (await this.deps.pastSales.scan(updatedTenant, options.monthsBack ?? 3)).periods,
        };
      } catch (error) {
        pastSales = { warning: error instanceof Error ? error.message : String(error) };
      }
    }
    const productOptions = (await this.deps.products.list(tenant.id, { pageSize: 100 })).items
      .filter((p) => p.active)
      .map((p) => ({ id: p.id, name: p.name }));
    const decided = updatedTenant.integrations.abacatepay;
    return {
      webhookId,
      imported: created.length,
      alreadyExisting: known.length,
      pendingTaxReview: created.filter((p) => p.taxStatus === 'PENDING_REVIEW'),
      confirmedByProfile: created.filter((p) => p.taxStatus === 'CONFIRMED'),
      skippedTestProducts,
      mergedDuplicates,
      pastSales,
      defaultProduct: {
        decided: Boolean(decided.defaultProductDecidedAt),
        productId: decided.defaultProductId,
        suggestedProductId: productOptions.length === 1 ? productOptions[0].id : undefined,
        options: productOptions,
      },
    };
  }

  /**
   * Cria um webhook NOVO no AbacatePay apontando para a URL atual da API (ex.: depois de trocar o
   * domínio — o AbacatePay não permite editar a URL de um webhook). Usa a key salva ou a informada,
   * com um segredo novo: o webhook antigo passa a ser recusado (pode ser apagado no painel).
   */
  async recreateAbacatePayWebhook(
    tenant: Tenant,
    apiKey?: string
  ): Promise<{
    webhookId: string;
    endpoint: string;
    previous?: { webhookId?: string; endpoint?: string };
  }> {
    if (!this.deps.publicBaseUrl)
      throw DomainError.validation('PUBLIC_BASE_URL não configurada no servidor');
    const integration = tenant.integrations.abacatepay;
    const informed = apiKey?.trim();
    const key =
      informed ||
      (integration?.encryptedApiKey
        ? this.deps.cipher.decrypt(integration.encryptedApiKey).toString('utf8')
        : undefined);
    if (!key) {
      throw DomainError.validation(
        'Informe a API key do AbacatePay (com a permissão WEBHOOK:CREATE) para criar o webhook'
      );
    }
    const endpoint = `${this.deps.publicBaseUrl.replace(/\/$/, '')}/v1/webhooks/abacatepay/${tenant.id}`;
    const webhookSecret = randomBytes(24).toString('base64url');
    const webhook = await this.deps.gateway.createWebhook(key, {
      name: 'açaínfe — emissão de NFS-e',
      endpoint,
      secret: webhookSecret,
      events: ABACATEPAY_EVENTS,
    });
    const current = (await this.deps.tenants.findById(tenant.id))!;
    const now = this.deps.clock.now();
    await this.deps.tenants.update({
      ...current,
      integrations: {
        ...current.integrations,
        abacatepay: {
          ...current.integrations.abacatepay,
          webhookSecret,
          webhookId: webhook.id,
          webhookEndpoint: endpoint,
          encryptedApiKey: informed
            ? this.deps.cipher.encrypt(Buffer.from(informed, 'utf8'))
            : current.integrations.abacatepay?.encryptedApiKey,
          connectedAt: current.integrations.abacatepay?.connectedAt ?? now,
        },
      },
      updatedAt: now,
    });
    this.deps.logger.info('Webhook do AbacatePay recriado', {
      tenantId: tenant.id,
      webhookId: webhook.id,
      previousWebhookId: integration?.webhookId,
    });
    return {
      webhookId: webhook.id,
      endpoint,
      previous: integration
        ? { webhookId: integration.webhookId, endpoint: integration.webhookEndpoint }
        : undefined,
    };
  }

  /** API key para o usuário conectar o MCP (exibida uma única vez) + comando pronto. */
  async issueMcpKey(
    tenant: Tenant,
    label?: string
  ): Promise<{ apiKey: string; key: ApiKeyView; mcpUrl?: string; claudeCodeCommand?: string }> {
    const { apiKey, key } = await this.deps.tenantService.issueApiKey(tenant.id, {
      label,
      via: 'APP',
    });
    const mcpUrl = this.deps.publicBaseUrl
      ? `${this.deps.publicBaseUrl.replace(/\/$/, '')}/mcp`
      : undefined;
    return {
      apiKey,
      key,
      mcpUrl,
      claudeCodeCommand: mcpUrl
        ? `claude mcp add --transport http acainfe ${mcpUrl} --header "Authorization: Bearer ${apiKey}"`
        : undefined,
    };
  }

  // ---------- Administração da cobertura / lista de espera ----------

  /**
   * Libera (ou bloqueia) um município por regime. Empresas da lista de espera que passam a ser
   * cobertas são ativadas e avisadas por e-mail e WhatsApp.
   */
  async setCoverage(input: {
    cityCode: string;
    cityName?: string;
    uf?: string;
    simples: boolean;
    others: boolean;
  }) {
    const coverage = createCoverage(input, this.deps.clock.now());
    await this.deps.coverage.upsert(coverage);
    const released: string[] = [];
    for (const tenant of await this.deps.tenants.findWaitlisted(coverage.cityCode)) {
      if (!coversRegime(coverage, tenant.taxRegime)) continue;
      await this.deps.tenants.update(activateTenant(tenant, this.deps.clock.now()));
      released.push(tenant.id);
      await this.notifyRelease(tenant);
    }
    return { coverage, released: released.length };
  }

  listCoverage() {
    return this.deps.coverage.list();
  }

  /** Lista de espera agrupada por município — para priorizar integrações. */
  async waitlistSummary() {
    const groups = new Map<
      string,
      { cityCode: string; cityName?: string; uf?: string; simples: number; others: number }
    >();
    for (const t of await this.deps.tenants.findWaitlisted()) {
      const g = groups.get(t.cityCode) ?? {
        cityCode: t.cityCode,
        cityName: t.cityName,
        uf: t.uf,
        simples: 0,
        others: 0,
      };
      if (['MEI', 'SIMPLES_NACIONAL', 'SIMPLES_NACIONAL_EXCESSO'].includes(t.taxRegime))
        g.simples++;
      else g.others++;
      groups.set(t.cityCode, g);
    }
    return [...groups.values()].sort((a, b) => b.simples + b.others - (a.simples + a.others));
  }

  private async notifyRelease(tenant: Tenant): Promise<void> {
    const users = await this.deps.users.findByTenant(tenant.id);
    const city = `${tenant.cityName ?? tenant.cityCode}${tenant.uf ? `/${tenant.uf}` : ''}`;
    const text = `Boa notícia! O açaínfe já emite notas fiscais para ${tenant.legalName} em ${city}. Acesse o app para concluir a configuração.`;
    for (const user of users) {
      await this.deps.email
        .send({
          to: user.email,
          subject: 'Sua empresa já pode emitir notas no açaínfe 🎉',
          text,
          html: `<p>${text}</p>`,
          attachments: [],
        })
        .catch((e: unknown) =>
          this.deps.logger.warn('Falha ao avisar liberação por e-mail', {
            userId: user.id,
            error: String(e),
          })
        );
      if (user.whatsapp) {
        await this.deps.whatsapp.sendText(user.whatsapp, text).catch((e: unknown) =>
          this.deps.logger.warn('Falha ao avisar liberação por WhatsApp', {
            userId: user.id,
            error: String(e),
          })
        );
      }
    }
  }
}
