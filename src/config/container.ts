import { FiscalSettingsService } from '../application/use-cases/fiscal-settings.service.js';
import {
  GinfesFiscalProvider,
  SBC_VERIFICATION_URL,
} from '../adapters/out/fiscal/ginfes/ginfes-fiscal-provider.js';
import {
  GinfesTransport,
  HttpsGinfesTransport,
} from '../adapters/out/fiscal/ginfes/ginfes-soap.js';
import { fiscalSystemFor } from '../domain/tenant/tenant.js';
import { Agenda } from 'agenda';
import { Db, MongoClient } from 'mongodb';
import {
  FiscalProviderResolver,
  MunicipalParamsGateway,
} from '../application/ports/fiscal-provider.js';
import {
  Clock,
  DanfseRenderer,
  EmailSender,
  IdGenerator,
  JobScheduler,
  Logger,
  BillingPaymentGateway,
  CompanyRegistry,
  PaymentGatewayAdmin,
  RemoteFileFetcher,
  WhatsappSender,
} from '../application/ports/services.js';
import { CertificateService } from '../application/use-cases/certificate.service.js';
import { CustomerService } from '../application/use-cases/customer.service.js';
import { RefundService } from '../application/use-cases/refund.service.js';
import { AccountService } from '../application/use-cases/account.service.js';
import { BillingService } from '../application/use-cases/billing.service.js';
import { AccountantService } from '../application/use-cases/accountant.service.js';
import { PastSalesService } from '../application/use-cases/past-sales.service.js';
import { FflateArchiveBuilder } from '../adapters/out/archive/fflate-archive.js';
import { AbacatePayBillingGateway } from '../adapters/out/gateway/abacatepay-billing-gateway.js';
import { OnboardingService } from '../application/use-cases/onboarding.service.js';
import { BrasilApiCompanyRegistry } from '../adapters/out/registry/brasilapi-company-registry.js';
import { AbacatePayAdminClient } from '../adapters/out/gateway/abacatepay-admin-client.js';
import { createCoverage } from '../domain/tenant/coverage.js';
import { SAO_BERNARDO_DO_CAMPO } from '../domain/tenant/tenant.js';
import { SafeHttpsFetcher } from '../adapters/out/http/safe-fetcher.js';
import { InvoiceService } from '../application/use-cases/invoice.service.js';
import { ProductService } from '../application/use-cases/product.service.js';
import { SaleService } from '../application/use-cases/sale.service.js';
import { TenantService } from '../application/use-cases/tenant.service.js';
import { AbacatePayWebhookService } from '../adapters/in/webhooks/abacatepay.service.js';
import { registerWorkers } from '../adapters/in/jobs/agenda-workers.js';
import { StaticServiceCodeCatalog } from '../adapters/out/catalog/static-service-code-catalog.js';
import { AesGcmEnvelopeCipher } from '../adapters/out/crypto/aes-gcm-cipher.js';
import { ForgeCertificateParser } from '../adapters/out/crypto/forge-certificate-parser.js';
import {
  InMemoryEmailSender,
  ResendEmailSender,
} from '../adapters/out/email/resend-email-sender.js';
import { MtlsHttpClient, NodeMtlsHttpClient } from '../adapters/out/fiscal/nacional/mtls-http.js';
import { NacionalFiscalProvider } from '../adapters/out/fiscal/nacional/nacional-fiscal-provider.js';
import {
  ensureIndexes,
  MongoAccountantReportRepository,
  MongoPastSaleRepository,
  MongoBillingRepository,
  MongoCertificateRepository,
  MongoCustomerRepository,
  MongoInvoiceRepository,
  MongoCoverageRepository,
  MongoLogoRepository,
  MongoUserRepository,
  MongoProductRepository,
  MongoSaleRepository,
  MongoTenantRepository,
} from '../adapters/out/mongo/mongo-repositories.js';
import { PdfmakeDanfseRenderer } from '../adapters/out/pdf/pdfmake-danfse-renderer.js';
import { AgendaJobScheduler, createAgenda } from '../adapters/out/scheduler/agenda-scheduler.js';
import {
  HmacDocumentLinks,
  HmacUploadLinks,
  JsonLogger,
  SystemClock,
  UuidGenerator,
} from '../adapters/out/system.js';
import {
  InMemoryWhatsappSender,
  UazapiWhatsappSender,
} from '../adapters/out/whatsapp/uazapi-whatsapp-sender.js';
import { Env, parseMasterKeys } from './env.js';

/** Pontos de substituição para testes (fakes de infraestrutura externa). */
export interface ContainerOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
  email?: EmailSender;
  whatsapp?: WhatsappSender;
  http?: MtlsHttpClient;
  renderer?: DanfseRenderer;
  scheduler?: JobScheduler;
  fiscalResolver?: FiscalProviderResolver;
  ginfesTransport?: GinfesTransport;
  fetcher?: RemoteFileFetcher;
  registry?: CompanyRegistry;
  gateway?: PaymentGatewayAdmin;
  billingGateway?: BillingPaymentGateway;
}

export interface Container {
  env: Env;
  client: MongoClient;
  db: Db;
  agenda: Agenda;
  logger: Logger;
  links: HmacDocumentLinks;
  uploadLinks: HmacUploadLinks;
  tenants: TenantService;
  customers: CustomerService;
  refunds: RefundService;
  accounts: AccountService;
  onboarding: OnboardingService;
  fiscalSettings: FiscalSettingsService;
  billing: BillingService;
  accountant: AccountantService;
  pastSales: PastSalesService;
  certificates: CertificateService;
  products: ProductService;
  sales: SaleService;
  invoices: InvoiceService;
  abacatepay: AbacatePayWebhookService;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Composition root: o único lugar que conhece todas as implementações concretas. */
export async function buildContainer(
  env: Env,
  overrides: ContainerOverrides = {}
): Promise<Container> {
  const logger = overrides.logger ?? new JsonLogger(env.NODE_ENV === 'test');
  const client = await MongoClient.connect(env.MONGODB_URI);
  const db = client.db(env.MONGODB_DB);
  await ensureIndexes(db);

  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new UuidGenerator();
  const agenda = createAgenda(db, { processEvery: env.JOBS_PROCESS_EVERY });
  const scheduler = overrides.scheduler ?? new AgendaJobScheduler(agenda);

  const repos = {
    tenants: new MongoTenantRepository(db),
    certificates: new MongoCertificateRepository(db),
    products: new MongoProductRepository(db),
    sales: new MongoSaleRepository(db),
    invoices: new MongoInvoiceRepository(db),
    customers: new MongoCustomerRepository(db),
    logos: new MongoLogoRepository(db),
    users: new MongoUserRepository(db),
    coverage: new MongoCoverageRepository(db),
    billing: new MongoBillingRepository(db),
    accountantReports: new MongoAccountantReportRepository(db),
    pastSales: new MongoPastSaleRepository(db),
  };
  // Cobertura inicial: SBC libera Simples/MEI (padrão nacional obrigatório desde 01/11/2026).
  if (!(await repos.coverage.get(SAO_BERNARDO_DO_CAMPO))) {
    await repos.coverage.upsert(
      createCoverage(
        {
          cityCode: SAO_BERNARDO_DO_CAMPO,
          cityName: 'São Bernardo do Campo',
          uf: 'SP',
          simples: true,
          others: false,
        },
        new Date()
      )
    );
  }

  let email = overrides.email;
  if (!email) {
    if (env.RESEND_API_KEY) email = new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM);
    else {
      logger.warn('RESEND_API_KEY ausente: e-mails ficarão apenas em memória');
      email = new InMemoryEmailSender();
    }
  }
  let whatsapp = overrides.whatsapp;
  if (!whatsapp) {
    if (env.UAZAPI_BASE_URL && env.UAZAPI_TOKEN)
      whatsapp = new UazapiWhatsappSender(env.UAZAPI_BASE_URL, env.UAZAPI_TOKEN);
    else {
      logger.warn('UAZAPI_BASE_URL/UAZAPI_TOKEN ausentes: WhatsApp ficará apenas em memória');
      whatsapp = new InMemoryWhatsappSender();
    }
  }

  const nacional = new NacionalFiscalProvider({
    http: overrides.http ?? new NodeMtlsHttpClient(),
    clock,
    logger,
    appVersion: env.APP_VERSION,
    endpoints: {
      sefinProduction: env.SEFIN_PRODUCTION_URL,
      sefinHomologation: env.SEFIN_HOMOLOGATION_URL,
      adnProduction: env.ADN_PRODUCTION_URL,
      adnHomologation: env.ADN_HOMOLOGATION_URL,
    },
  });
  // Ginfes: ME/EPP de municípios que ainda não liberaram o Emissor Nacional (ex.: São Bernardo).
  const ginfes = new GinfesFiscalProvider(
    overrides.ginfesTransport ?? new HttpsGinfesTransport(),
    {
      productionUrl: env.GINFES_PRODUCTION_URL,
      homologationUrl: env.GINFES_HOMOLOGATION_URL,
      pilot: env.GINFES_PILOT,
      pollDelaysMs: env.GINFES_POLL_DELAYS_MS,
      rtcGroups: env.GINFES_RTC_GROUPS,
      verificationUrl: SBC_VERIFICATION_URL,
    },
    clock
  );
  const ginfesCities = env.GINFES_CITIES.split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const fiscalResolver: FiscalProviderResolver = overrides.fiscalResolver ?? {
    resolve: (tenant) => (fiscalSystemFor(tenant, ginfesCities) === 'GINFES' ? ginfes : nacional),
  };
  const municipalParams: MunicipalParamsGateway = nacional;

  const links = new HmacDocumentLinks(env.PUBLIC_BASE_URL, env.LINK_SIGNING_SECRET);
  const uploadLinks = new HmacUploadLinks(env.PUBLIC_BASE_URL, env.LINK_SIGNING_SECRET);
  const certificates = new CertificateService({
    certificates: repos.certificates,
    tenants: repos.tenants,
    parser: new ForgeCertificateParser(),
    cipher: new AesGcmEnvelopeCipher(env.MASTER_KEY_ID, parseMasterKeys(env.MASTER_KEYS)),
    clock,
    ids,
    email,
    logger,
    uploadLinks,
  });
  const tenants = new TenantService({
    tenants: repos.tenants,
    logos: repos.logos,
    fetcher: overrides.fetcher ?? new SafeHttpsFetcher(),
    clock,
    ids,
  });
  const customers = new CustomerService({ customers: repos.customers, clock, ids, logger });
  const products = new ProductService({
    products: repos.products,
    catalog: new StaticServiceCodeCatalog(),
    municipalParams,
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
    gateway:
      overrides.billingGateway ??
      (env.BILLING_ABACATEPAY_API_KEY
        ? new AbacatePayBillingGateway(env.BILLING_ABACATEPAY_API_KEY, env.ABACATEPAY_API_URL)
        : undefined),
    email,
    whatsapp,
    clock,
    ids,
    logger,
    config: {
      pricePerInvoiceCents: env.BILLING_PRICE_PER_INVOICE_CENTS,
      graceDays: env.BILLING_GRACE_DAYS,
      pixExpiresInSeconds: env.BILLING_PIX_EXPIRES_IN_SECONDS,
    },
  });
  if (!env.BILLING_ABACATEPAY_API_KEY && !overrides.billingGateway) {
    logger.warn(
      'BILLING_ABACATEPAY_API_KEY ausente: cobranças acumulam, mas o Pix não é gerado (só pagamento manual)'
    );
  }
  const invoices = new InvoiceService({
    invoices: repos.invoices,
    tenants: repos.tenants,
    sales: repos.sales,
    logos: repos.logos,
    billing,
    certificates,
    providers: fiscalResolver,
    scheduler,
    renderer: overrides.renderer ?? new PdfmakeDanfseRenderer(),
    email,
    whatsapp,
    links,
    clock,
    logger,
  });
  const accountant = new AccountantService({
    tenants: repos.tenants,
    invoices: repos.invoices,
    sales: repos.sales,
    reports: repos.accountantReports,
    logos: repos.logos,
    renderer: overrides.renderer ?? new PdfmakeDanfseRenderer(),
    archive: new FflateArchiveBuilder(),
    links,
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
    providers: fiscalResolver,
    scheduler,
    clock,
    logger,
  });
  const cipher = new AesGcmEnvelopeCipher(env.MASTER_KEY_ID, parseMasterKeys(env.MASTER_KEYS));
  const paymentGateway = overrides.gateway ?? new AbacatePayAdminClient(env.ABACATEPAY_API_URL);
  const accounts = new AccountService({ users: repos.users, tenants: repos.tenants, clock, ids });
  const pastSales = new PastSalesService({
    pastSales: repos.pastSales,
    sales: repos.sales,
    saleService: sales,
    gateway: paymentGateway,
    cipher,
    clock,
    ids,
    logger,
    municipalInvoices: invoices,
  });
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
    registry: overrides.registry ?? new BrasilApiCompanyRegistry(env.BRASILAPI_URL),
    gateway: paymentGateway,
    cipher,
    email,
    whatsapp,
    clock,
    ids,
    logger,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    pastSales,
    productService: products,
    fiscalSystemOf: (tenant) => fiscalSystemFor(tenant, ginfesCities),
    approvalRequired: (tenant) => Boolean(fiscalResolver.resolve(tenant).requiresApproval),
  });
  const fiscalSettings = new FiscalSettingsService({
    onboarding,
    products: repos.products,
    email,
    whatsapp,
    clock,
    logger,
  });
  const abacatepay = new AbacatePayWebhookService({ tenants, sales, refunds, logger });

  return {
    env,
    client,
    db,
    agenda,
    logger,
    links,
    uploadLinks,
    tenants,
    customers,
    refunds,
    accounts,
    onboarding,
    fiscalSettings,
    billing,
    accountant,
    pastSales,
    certificates,
    products,
    sales,
    invoices,
    abacatepay,
    async start() {
      if (!env.JOBS_ENABLED) return;
      await registerWorkers(agenda, {
        invoices,
        refunds,
        sales,
        billing,
        accountant,
        certificates,
        logger,
      });
      await agenda.start();
    },
    async close() {
      if (env.JOBS_ENABLED) await agenda.stop(false).catch(() => undefined);
      await client.close();
    },
  };
}
