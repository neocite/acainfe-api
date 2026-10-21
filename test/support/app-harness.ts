import { FiscalSettingsService } from '../../src/application/use-cases/fiscal-settings.service.js';
import { CertificateService } from '../../src/application/use-cases/certificate.service.js';
import { CustomerService } from '../../src/application/use-cases/customer.service.js';
import { RefundService } from '../../src/application/use-cases/refund.service.js';
import { AccountService } from '../../src/application/use-cases/account.service.js';
import { BillingService } from '../../src/application/use-cases/billing.service.js';
import { AccountantService } from '../../src/application/use-cases/accountant.service.js';
import { FflateArchiveBuilder } from '../../src/adapters/out/archive/fflate-archive.js';
import { OnboardingService } from '../../src/application/use-cases/onboarding.service.js';
import {
  CompanyInfo,
  GatewayCustomer,
  GatewayPaidCharge,
  GatewayProduct,
} from '../../src/application/ports/services.js';
import { PastSalesService } from '../../src/application/use-cases/past-sales.service.js';
import { DomainError } from '../../src/domain/shared/domain-error.js';
import { InvoiceService } from '../../src/application/use-cases/invoice.service.js';
import { ProductService } from '../../src/application/use-cases/product.service.js';
import { SaleService } from '../../src/application/use-cases/sale.service.js';
import { TenantService } from '../../src/application/use-cases/tenant.service.js';
import { StaticServiceCodeCatalog } from '../../src/adapters/out/catalog/static-service-code-catalog.js';
import { ForgeCertificateParser } from '../../src/adapters/out/crypto/forge-certificate-parser.js';
import { TRUST_ANY } from '../../src/adapters/out/crypto/icp-brasil-trust.js';
import { InMemoryEmailSender } from '../../src/adapters/out/email/resend-email-sender.js';
import { InMemoryWhatsappSender } from '../../src/adapters/out/whatsapp/uazapi-whatsapp-sender.js';
import { MunicipalParamsGateway } from '../../src/application/ports/fiscal-provider.js';
import { NOW } from './fixtures.js';
import {
  FakeCipher,
  FakeLinks,
  FakeRenderer,
  FixedClock,
  InMemoryAccountantReports,
  InMemoryBilling,
  InMemoryCertificates,
  InMemoryCoverage,
  InMemoryCustomers,
  InMemoryUsers,
  InMemoryLogos,
  InMemoryPastSales,
  InMemoryInvoices,
  InMemoryProducts,
  InMemorySales,
  InMemoryTenants,
  RecordingScheduler,
  ScriptedFiscalProvider,
  SequentialIds,
  SilentLogger,
} from './in-memory.js';
import { generateTestPfx } from './test-certificate.js';

/** Monta a camada de aplicação inteira com adaptadores em memória. */
export function buildAppHarness() {
  const clock = new FixedClock(NOW);
  const ids = new SequentialIds();
  const logger = new SilentLogger();
  const repos = {
    tenants: new InMemoryTenants(),
    certificates: new InMemoryCertificates(),
    products: new InMemoryProducts(),
    sales: new InMemorySales(),
    invoices: new InMemoryInvoices(),
    customers: new InMemoryCustomers(),
    logos: new InMemoryLogos(),
    users: new InMemoryUsers(),
    coverage: new InMemoryCoverage(),
    billing: new InMemoryBilling(),
    accountantReports: new InMemoryAccountantReports(),
    pastSales: new InMemoryPastSales(),
  };
  const billingGateway = {
    created: [] as {
      amountCents: number;
      metadata: Record<string, string>;
      customer?: { name: string; email: string; taxId: string; cellphone: string };
    }[],
    async createPix(input: {
      amountCents: number;
      metadata: Record<string, string>;
      customer?: { name: string; email: string; taxId: string; cellphone: string };
    }) {
      billingGateway.created.push(input);
      const n = billingGateway.created.length;
      return {
        providerId: `pix_char_${n}`,
        copyPaste: `00020126PIX${n}`,
        expiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
      };
    },
  };
  const registry = {
    companies: new Map<string, CompanyInfo>([['11222333000181', sampleCompany()]]),
    async lookup(cnpj: string) {
      return registry.companies.get(cnpj) ?? null;
    },
  };
  const gateway = {
    products: [] as GatewayProduct[],
    webhooks: [] as {
      apiKey: string;
      name: string;
      endpoint: string;
      secret: string;
      events: string[];
    }[],
    validKey: 'abc_live_valid_key',
    async listProducts(apiKey: string) {
      if (apiKey !== gateway.validKey)
        throw DomainError.validation('API key do AbacatePay inválida');
      return gateway.products;
    },
    charges: [] as GatewayPaidCharge[],
    customers: [] as GatewayCustomer[],
    /** Simula key sem CHECKOUT:READ etc. */
    canReadCharges: true,
    async listCharges(apiKey: string) {
      if (apiKey !== gateway.validKey)
        throw DomainError.validation('API key do AbacatePay inválida');
      if (!gateway.canReadCharges) {
        throw new DomainError(
          'VALIDATION',
          'A API key do AbacatePay precisa da(s) permissão(ões) CHECKOUT:READ',
          {
            missingPermission: 'CHECKOUT:READ',
          }
        );
      }
      return gateway.charges;
    },
    async listCustomers() {
      return gateway.customers;
    },
    async createWebhook(
      apiKey: string,
      webhook: { name: string; endpoint: string; secret: string; events: string[] }
    ) {
      gateway.webhooks.push({ apiKey, ...webhook });
      return { id: `webh_${gateway.webhooks.length}` };
    },
  };
  const fetched: string[] = [];
  const fetcher = {
    remote: new Map<string, Buffer>(),
    async fetch(url: string) {
      fetched.push(url);
      const data = fetcher.remote.get(url);
      if (!data) throw new Error('404');
      return data;
    },
  };
  const uploadLinks = {
    certificateUploadUrl: (tenantId: string, ttl: number) => ({
      url: `https://acainfe.test/upload/${tenantId}`,
      expiresAt: new Date(NOW.getTime() + ttl),
    }),
  };
  const renderer = new FakeRenderer();
  const scheduler = new RecordingScheduler();
  const email = new InMemoryEmailSender();
  const whatsapp = new InMemoryWhatsappSender();
  const provider = new ScriptedFiscalProvider();
  const municipal: MunicipalParamsGateway & { calls: unknown[]; issRateBps: number | null } = {
    calls: [],
    /** null simula município que não publica a alíquota na API nacional. */
    issRateBps: 200,
    async get(cityCode, code, _c, ctx) {
      municipal.calls.push({ cityCode, code, tenant: ctx.tenant.id });
      if (municipal.issRateBps === null) return null;
      return { cityCode, nationalServiceCode: code, issRateBps: municipal.issRateBps, raw: {} };
    },
  };

  const certificates = new CertificateService({
    certificates: repos.certificates,
    tenants: repos.tenants,
    // Testes usam certificado autoassinado; a cadeia ICP-Brasil é testada no próprio adaptador.
    trust: TRUST_ANY,
    parser: new ForgeCertificateParser(),
    cipher: new FakeCipher(),
    clock,
    ids,
    email,
    logger,
    uploadLinks,
  });
  const tenants = new TenantService({
    tenants: repos.tenants,
    logos: repos.logos,
    fetcher,
    clock,
    ids,
  });
  const customers = new CustomerService({ customers: repos.customers, clock, ids, logger });
  const products = new ProductService({
    products: repos.products,
    catalog: new StaticServiceCodeCatalog(),
    municipalParams: municipal,
    certificates,
    clock,
    ids,
  });
  const sales = new SaleService({ ...repos, customers, scheduler, clock, ids, logger });
  const billing = new BillingService({
    billing: repos.billing,
    invoices: repos.invoices,
    tenants: repos.tenants,
    users: repos.users,
    scheduler,
    gateway: billingGateway,
    email,
    whatsapp,
    clock,
    ids,
    logger,
    config: { pricePerInvoiceCents: 80, graceDays: 7, pixExpiresInSeconds: 3 * 86_400 },
  });
  const invoices = new InvoiceService({
    invoices: repos.invoices,
    tenants: repos.tenants,
    sales: repos.sales,
    logos: repos.logos,
    billing,
    certificates,
    providers: { resolve: () => provider },
    scheduler,
    renderer,
    email,
    whatsapp,
    links: new FakeLinks(),
    clock,
    logger,
  });

  const pastSales = new PastSalesService({
    pastSales: repos.pastSales,
    sales: repos.sales,
    saleService: sales,
    gateway,
    cipher: new FakeCipher(),
    clock,
    ids,
    logger,
    municipalInvoices: invoices,
  });
  const accounts = new AccountService({ users: repos.users, tenants: repos.tenants, clock, ids });
  const onboarding = new OnboardingService({
    accounts,
    tenantService: tenants,
    certificates,
    sales,
    tenants: repos.tenants,
    users: repos.users,
    coverage: repos.coverage,
    products: repos.products,
    parser: new ForgeCertificateParser(),
    registry,
    gateway,
    cipher: new FakeCipher(),
    email,
    whatsapp,
    clock,
    ids,
    logger,
    publicBaseUrl: 'https://api.acainfe.test',
    pastSales,
    productService: products,
  });
  const fiscalSettings = new FiscalSettingsService({
    onboarding,
    products: repos.products,
    email,
    whatsapp,
    clock,
    logger,
  });
  const accountant = new AccountantService({
    tenants: repos.tenants,
    invoices: repos.invoices,
    sales: repos.sales,
    reports: repos.accountantReports,
    logos: repos.logos,
    renderer,
    archive: new FflateArchiveBuilder(),
    links: new FakeLinks(),
    email,
    whatsapp,
    clock,
    ids,
    logger,
  });
  const refunds = new RefundService({
    sales: repos.sales,
    invoices: repos.invoices,
    tenants: repos.tenants,
    certificates,
    providers: { resolve: () => provider },
    scheduler,
    clock,
    logger,
  });

  async function onboard(
    options: { withCertificate?: boolean; businessType?: 'INFOPRODUCER' | 'MICROSAAS' } = {}
  ) {
    const { tenant: view, apiKey } = await tenants.create({
      cnpj: '11222333000181',
      legalName: 'Empresa Teste LTDA',
      municipalRegistration: '123456',
      taxRegime: 'SIMPLES_NACIONAL',
      simplesNacionalTaxRateBps: 600,
      email: 'financeiro@empresa.com.br',
      environment: 'PRODUCTION',
      businessType: options.businessType ?? 'INFOPRODUCER',
    });
    const tenant = (await repos.tenants.findById(view.id))!;
    if (options.withCertificate ?? true) {
      const { pfx, password } = generateTestPfx({
        notBefore: new Date(NOW.getTime() - 86_400_000),
        notAfter: new Date(NOW.getTime() + 365 * 86_400_000),
      });
      await certificates.upload(tenant, pfx, password);
    }
    return { tenant, apiKey };
  }

  return {
    clock,
    ids,
    logger,
    repos,
    scheduler,
    email,
    whatsapp,
    provider,
    municipal,
    renderer,
    fetcher,
    fetched,
    certificates,
    tenants,
    customers,
    products,
    sales,
    invoices,
    refunds,
    billing,
    billingGateway,
    accountant,
    pastSales,
    accounts,
    onboarding,
    fiscalSettings,
    registry,
    gateway,
    onboard,
  };
}

export function sampleCompany(overrides: Partial<CompanyInfo> = {}): CompanyInfo {
  return {
    cnpj: '11222333000181',
    legalName: 'EMPRESA TESTE LTDA',
    tradeName: 'Teste Dev',
    cityCode: '3548708',
    cityName: 'São Bernardo Do Campo',
    uf: 'SP',
    simplesNacional: true,
    mei: false,
    active: true,
    situation: 'ATIVA',
    cnaes: [
      {
        code: '6201501',
        description: 'Desenvolvimento de programas de computador sob encomenda',
        primary: true,
      },
      {
        code: '8599604',
        description: 'Treinamento em desenvolvimento profissional e gerencial',
        primary: false,
      },
    ],
    address: {
      street: 'Rua Marechal Deodoro',
      number: '100',
      district: 'Centro',
      zipCode: '09715000',
    },
    ...overrides,
  };
}
