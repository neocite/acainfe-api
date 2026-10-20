import {
  CertificateMaterial,
  FiscalProvider,
  IssueOutcome,
} from '../../src/application/ports/fiscal-provider.js';
import {
  AccountantReportRepository,
  PastSaleRepository,
  BillingRepository,
  CertificateRepository,
  CoverageRepository,
  CustomerFilter,
  CustomerRepository,
  LogoRepository,
  InvoiceFilter,
  InvoiceRepository,
  Page,
  ProductFilter,
  ProductRepository,
  SaleRepository,
  TenantRepository,
  UserRepository,
} from '../../src/application/ports/repositories.js';
import {
  Clock,
  DanfseRenderer,
  DocumentLinks,
  IdGenerator,
  JobScheduler,
  Logger,
  SecretCipher,
} from '../../src/application/ports/services.js';
import { User } from '../../src/domain/account/user.js';
import { PastSale } from '../../src/domain/backfill/past-sale.js';
import { AccountantReport } from '../../src/domain/accounting/accountant-report.js';
import {
  BillingAccount,
  BillingCharge,
  BillingPayment,
  BillingUsage,
} from '../../src/domain/billing/billing.js';
import { Certificate } from '../../src/domain/certificate/certificate.js';
import { CityCoverage } from '../../src/domain/tenant/coverage.js';
import { CustomerRecord } from '../../src/domain/customer/customer-record.js';
import { Logo } from '../../src/domain/tenant/logo.js';
import { FiscalError, Invoice, IssuedNfse } from '../../src/domain/invoice/invoice.js';
import { Product } from '../../src/domain/product/product.js';
import { Sale, SaleRefund, SaleSource } from '../../src/domain/sale/sale.js';
import { DomainError } from '../../src/domain/shared/domain-error.js';
import { Tenant } from '../../src/domain/tenant/tenant.js';

const copy = <T>(v: T): T => structuredClone(v);
const page = <T>(items: T[], p: { page?: number; pageSize?: number }): Page<T> => {
  const pageNo = p.page ?? 1;
  const size = p.pageSize ?? 20;
  return {
    items: items.slice((pageNo - 1) * size, pageNo * size),
    total: items.length,
    page: pageNo,
    pageSize: size,
  };
};

export class FixedClock implements Clock {
  constructor(public current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    return `id-${++this.n}`;
  }
}

export class SilentLogger implements Logger {
  readonly entries: { level: string; message: string }[] = [];
  info(message: string) {
    this.entries.push({ level: 'info', message });
  }
  warn(message: string) {
    this.entries.push({ level: 'warn', message });
  }
  error(message: string) {
    this.entries.push({ level: 'error', message });
  }
}

export class InMemoryTenants implements TenantRepository {
  readonly items = new Map<string, Tenant>();
  async create(t: Tenant) {
    if ([...this.items.values()].some((x) => x.cnpj === t.cnpj))
      throw new DomainError('CONFLICT', 'dup');
    this.items.set(t.id, copy(t));
  }
  async findById(id: string) {
    return copy(this.items.get(id) ?? null);
  }
  async findByCnpj(cnpj: string) {
    return copy([...this.items.values()].find((t) => t.cnpj === cnpj) ?? null);
  }
  async adoptApiKey(
    tenantId: string,
    record: import('../../src/domain/tenant/tenant.js').ApiKeyRecord
  ) {
    const t = this.items.get(tenantId);
    if (
      !t ||
      !t.apiKeyHashes.includes(record.hash) ||
      t.apiKeys?.some((k) => k.hash === record.hash)
    )
      return;
    t.apiKeys = [...(t.apiKeys ?? []), { ...record }];
  }
  async touchApiKey(tenantId: string, hash: string, at: Date) {
    const t = this.items.get(tenantId);
    const record = t?.apiKeys?.find((k) => k.hash === hash);
    if (record) record.lastUsedAt = at;
  }
  async findByApiKeyHash(hash: string) {
    return copy([...this.items.values()].find((t) => t.apiKeyHashes.includes(hash)) ?? null);
  }
  async update(t: Tenant) {
    const current = this.items.get(t.id)!;
    this.items.set(t.id, { ...copy(t), lastDpsNumber: current.lastDpsNumber });
  }
  async setNumbering(tenantId: string, series: string, lastDpsNumber: number, confirmedAt: Date) {
    const t = this.items.get(tenantId)!;
    Object.assign(t, {
      dpsSeries: series,
      lastDpsNumber,
      numberingConfirmedAt: confirmedAt,
      updatedAt: confirmedAt,
    });
  }
  async findWithAccountantReport() {
    return copy(
      [...this.items.values()].filter((t) => t.accountant?.monthlyReport && t.status === 'ACTIVE')
    );
  }
  async findWaitlisted(cityCode?: string) {
    return copy(
      [...this.items.values()].filter(
        (t) => t.status === 'WAITLIST' && (!cityCode || t.cityCode === cityCode)
      )
    );
  }
  async reserveDpsNumbers(tenantId: string, count: number) {
    const t = this.items.get(tenantId);
    if (!t) throw DomainError.notFound('Empresa', tenantId);
    t.lastDpsNumber += count;
    return { first: t.lastDpsNumber - count + 1, series: t.dpsSeries };
  }
}

export class InMemoryCertificates implements CertificateRepository {
  readonly items: Certificate[] = [];
  async saveActive(c: Certificate) {
    this.items.forEach((x) => x.tenantId === c.tenantId && (x.active = false));
    this.items.push(copy(c));
  }
  async findActive(tenantId: string) {
    return copy(this.items.find((c) => c.tenantId === tenantId && c.active) ?? null);
  }
  async listActiveExpiringBefore(date: Date) {
    return copy(this.items.filter((c) => c.active && c.metadata.notAfter <= date));
  }
}

export class InMemoryProducts implements ProductRepository {
  readonly items = new Map<string, Product>();
  async create(p: Product) {
    this.items.set(p.id, copy(p));
  }
  async update(p: Product) {
    this.items.set(p.id, copy(p));
  }
  async findById(tenantId: string, id: string) {
    const p = this.items.get(id);
    return p && p.tenantId === tenantId ? copy(p) : null;
  }
  async findManyByIds(tenantId: string, ids: string[]) {
    return copy(
      [...this.items.values()].filter((p) => p.tenantId === tenantId && ids.includes(p.id))
    );
  }
  async findManyByExternalIds(tenantId: string, ids: string[]) {
    return copy(
      [...this.items.values()].filter(
        (p) =>
          p.tenantId === tenantId &&
          [p.externalId, ...(p.aliasExternalIds ?? [])].some((e) => e && ids.includes(e))
      )
    );
  }
  async list(tenantId: string, filter: ProductFilter) {
    const items = [...this.items.values()].filter(
      (p) =>
        p.tenantId === tenantId &&
        (filter.includeInactive || p.active) &&
        (!filter.pendingTaxReview || p.taxStatus === 'PENDING_REVIEW') &&
        (!filter.search || p.name.toLowerCase().includes(filter.search.toLowerCase()))
    );
    return page(copy(items), filter);
  }
}

export class InMemorySales implements SaleRepository {
  readonly items = new Map<string, Sale>();
  async create(s: Sale) {
    if (
      await this.findByExternalId(s.tenantId, s.source, s.externalId, s.environment ?? 'PRODUCTION')
    )
      throw new DomainError('CONFLICT', 'dup');
    this.items.set(s.id, copy(s));
  }
  async findById(tenantId: string, id: string) {
    const s = this.items.get(id);
    return s && s.tenantId === tenantId ? copy(s) : null;
  }
  async findManyByIds(tenantId: string, ids: string[]) {
    return copy(
      [...this.items.values()].filter((s) => s.tenantId === tenantId && ids.includes(s.id))
    );
  }
  async findByExternalId(
    tenantId: string,
    source: SaleSource,
    externalId: string,
    environment: 'PRODUCTION' | 'HOMOLOGATION'
  ) {
    return copy(
      [...this.items.values()].find(
        (s) =>
          s.tenantId === tenantId &&
          s.source === source &&
          s.externalId === externalId &&
          s.environment === environment
      ) ?? null
    );
  }
  async setInvoiceIds(saleId: string, invoiceIds: string[]) {
    this.items.get(saleId)!.invoiceIds = invoiceIds;
  }
  async update(sale: Sale) {
    this.items.set(sale.id, copy(sale));
  }
  async findHeld(tenantId?: string) {
    return copy(
      [...this.items.values()].filter((s) => s.held && (!tenantId || s.tenantId === tenantId))
    );
  }
  async setRefund(saleId: string, refund: SaleRefund) {
    const sale = this.items.get(saleId)!;
    sale.refund ??= copy(refund);
  }
}

export class InMemoryCustomers implements CustomerRepository {
  readonly items = new Map<string, CustomerRecord>();
  async create(c: CustomerRecord) {
    this.items.set(c.id, copy(c));
  }
  async update(c: CustomerRecord) {
    this.items.set(c.id, copy(c));
  }
  async delete(tenantId: string, id: string) {
    const c = this.items.get(id);
    if (!c || c.tenantId !== tenantId) return false;
    return this.items.delete(id);
  }
  async findById(tenantId: string, id: string) {
    const c = this.items.get(id);
    return c && c.tenantId === tenantId ? copy(c) : null;
  }
  async findMatch(
    tenantId: string,
    keys: { taxId?: string; externalId?: string; email?: string; phone?: string }
  ) {
    const all = [...this.items.values()].filter((c) => c.tenantId === tenantId);
    const found =
      (keys.taxId && all.find((c) => c.taxId?.value === keys.taxId)) ||
      (keys.externalId && all.find((c) => c.externalId === keys.externalId)) ||
      (keys.email && all.find((c) => c.email === keys.email)) ||
      (keys.phone && all.find((c) => c.phone === keys.phone)) ||
      null;
    return copy(found);
  }
  async list(tenantId: string, filter: CustomerFilter) {
    const q = filter.search?.toLowerCase();
    const items = [...this.items.values()].filter(
      (c) =>
        c.tenantId === tenantId &&
        (!q || `${c.name} ${c.email} ${c.taxId?.value}`.toLowerCase().includes(q))
    );
    return page(copy(items), filter);
  }
}

export class InMemoryLogos implements LogoRepository {
  readonly items = new Map<string, Logo>();
  async save(tenantId: string, logo: Logo) {
    this.items.set(tenantId, logo);
  }
  async find(tenantId: string) {
    return this.items.get(tenantId) ?? null;
  }
  async delete(tenantId: string) {
    this.items.delete(tenantId);
  }
}

export class InMemoryInvoices implements InvoiceRepository {
  readonly items = new Map<string, Invoice>();
  async createMany(list: Invoice[]) {
    list.forEach((i) => this.items.set(i.id, copy(i)));
  }
  async findById(tenantId: string, id: string) {
    const i = this.items.get(id);
    return i && i.tenantId === tenantId ? copy(i) : null;
  }
  async findByIdInternal(id: string) {
    return copy(this.items.get(id) ?? null);
  }
  async list(tenantId: string, f: InvoiceFilter) {
    const items = [...this.items.values()].filter(
      (i) =>
        i.tenantId === tenantId &&
        (!f.status?.length || f.status.includes(i.status)) &&
        (!f.saleId || i.saleId === f.saleId) &&
        (!f.customerTaxId || i.customer.taxId?.value === f.customerTaxId)
    );
    return page(copy(items), f);
  }
  async updateIfStatus(invoice: Invoice, expected: Invoice['status']) {
    const current = this.items.get(invoice.id);
    if (!current || current.status !== expected) return false;
    this.items.set(invoice.id, copy(invoice));
    return true;
  }
  async update(invoice: Invoice) {
    this.items.set(invoice.id, copy(invoice));
  }
  async saveDelivery(invoice: Invoice, channel: Invoice['deliveries'][number]['channel']) {
    const current = this.items.get(invoice.id)!;
    const delivery = invoice.deliveries.find((d) => d.channel === channel)!;
    current.deliveries = current.deliveries.some((d) => d.channel === channel)
      ? current.deliveries.map((d) => (d.channel === channel ? copy(delivery) : d))
      : [...current.deliveries, copy(delivery)];
    const last = invoice.history.at(-1);
    if (last && last.at.getTime() === invoice.updatedAt.getTime()) current.history.push(copy(last));
    current.updatedAt = invoice.updatedAt;
  }

  async findDue(now: Date) {
    return copy(
      [...this.items.values()].filter(
        (i) =>
          i.status === 'PENDING' ||
          (i.status === 'RETRYING' && i.nextAttemptAt && i.nextAttemptAt <= now)
      )
    );
  }
  async findStuckProcessing(before: Date) {
    return copy(
      [...this.items.values()].filter((i) => i.status === 'PROCESSING' && i.updatedAt <= before)
    );
  }
  async findByNfseNumber(tenantId: string, number: string) {
    return copy(
      [...this.items.values()].find((i) => i.tenantId === tenantId && i.nfse?.number === number) ??
        null
    );
  }
  async findIssuedBetween(tenantId: string, from: Date, to: Date) {
    return copy(
      [...this.items.values()].filter(
        (i) => i.tenantId === tenantId && i.nfse && i.nfse.issuedAt >= from && i.nfse.issuedAt < to
      )
    );
  }
  async findUnbilled() {
    return copy([...this.items.values()].filter((i) => i.nfse && !i.billedChargeId));
  }
  async markBilled(invoiceId: string, chargeId: string) {
    const i = this.items.get(invoiceId);
    if (i) i.billedChargeId = chargeId;
  }
  async findByTenantAndStatus(tenantId: string, status: Invoice['status'][]) {
    return copy(
      [...this.items.values()].filter((i) => i.tenantId === tenantId && status.includes(i.status))
    );
  }
  async findPendingDeliveries(before: Date) {
    return copy(
      [...this.items.values()].filter(
        (i) => i.deliveries.some((d) => d.status === 'PENDING') && i.updatedAt <= before
      )
    );
  }
}

export class RecordingScheduler implements JobScheduler {
  readonly issues: { invoiceId: string; at?: Date }[] = [];
  readonly deliveries: { invoiceId: string; channel: string; at?: Date }[] = [];
  fail = false;
  async scheduleIssue(invoiceId: string, at?: Date) {
    if (this.fail) throw new Error('fila indisponível');
    this.issues.push({ invoiceId, at });
  }
  async scheduleDelivery(invoiceId: string, channel: 'EMAIL' | 'WHATSAPP', at?: Date) {
    if (this.fail) throw new Error('fila indisponível');
    this.deliveries.push({ invoiceId, channel, at });
  }
  readonly charges: { invoiceId: string; at?: Date }[] = [];
  async scheduleCharge(invoiceId: string, at?: Date) {
    if (this.fail) throw new Error('fila indisponível');
    this.charges.push({ invoiceId, at });
  }
  readonly refunds: { invoiceId: string; at?: Date }[] = [];
  async scheduleRefund(invoiceId: string, at?: Date) {
    if (this.fail) throw new Error('fila indisponível');
    this.refunds.push({ invoiceId, at });
  }
}

/** Cifra reversível trivial para testes de aplicação (a real é testada no adapter). */
export class FakeCipher implements SecretCipher {
  encrypt(plain: Buffer) {
    return `enc:${plain.toString('base64')}`;
  }
  decrypt(sealed: string) {
    return Buffer.from(sealed.slice(4), 'base64');
  }
}

export class FakeRenderer implements DanfseRenderer {
  readonly calls: { invoiceId: string; withLogo: boolean }[] = [];
  async render(invoice: Invoice, _tenant: Tenant, options?: { logo?: Logo }) {
    this.calls.push({ invoiceId: invoice.id, withLogo: Boolean(options?.logo) });
    return Buffer.from(`%PDF-fake ${invoice.id}`);
  }
}

export class FakeLinks implements DocumentLinks {
  pdfUrl(id: string) {
    return `https://acainfe.test/pdf/${id}`;
  }
  accountantPackageUrl(tenantId: string, period: string) {
    return `https://acainfe.test/pkg/${tenantId}/${period}`;
  }
}

export class InMemoryAccountantReports implements AccountantReportRepository {
  readonly items: AccountantReport[] = [];
  async findByPeriod(tenantId: string, period: string) {
    return copy(this.items.find((r) => r.tenantId === tenantId && r.period === period) ?? null);
  }
  async save(report: AccountantReport) {
    const i = this.items.findIndex(
      (r) => r.tenantId === report.tenantId && r.period === report.period
    );
    if (i >= 0) this.items[i] = copy(report);
    else this.items.push(copy(report));
  }
  async listByTenant(tenantId: string) {
    return copy(this.items.filter((r) => r.tenantId === tenantId));
  }
}

export const sampleNfse = (n = '1'): IssuedNfse => ({
  accessKey: '3548708211222333000181000000000000126100000000017'.padEnd(50, '0'),
  number: n,
  issuedAt: new Date('2026-10-18T13:00:00Z'),
  xml: '<NFSe/>',
  verificationUrl: 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=x',
});

type Behaviour = 'ISSUE' | 'REJECT' | 'DOWN' | 'DUPLICATE' | 'CRASH';

export class ScriptedFiscalProvider implements FiscalProvider {
  readonly name = 'FAKE';
  /** Simula integração em modo piloto. */
  requiresApproval = false;
  preview(invoice: Invoice) {
    return `<Rps><Numero>${invoice.dps.number}</Numero></Rps>`;
  }
  /** Notas que "a prefeitura" devolve na consulta (ex.: emitidas por outro sistema). */
  municipalNotes: import('../../src/application/ports/fiscal-provider.js').MunicipalNfseSummary[] =
    [];
  async listIssued() {
    return this.municipalNotes;
  }
  behaviours: Behaviour[] = [];
  existing: IssuedNfse | null = null;
  cancelResult: { ok: true } | { ok: false; errors: FiscalError[] } = { ok: true };
  readonly calls: string[] = [];
  private counter = 0;

  async issue(invoice: Invoice, _t: Tenant, _c: CertificateMaterial): Promise<IssueOutcome> {
    this.calls.push(`issue:${invoice.id}`);
    const b = this.behaviours.shift() ?? 'ISSUE';
    if (b === 'DOWN') {
      const { FiscalProviderUnavailableError } =
        await import('../../src/application/ports/fiscal-provider.js');
      throw new FiscalProviderUnavailableError('Sefin HTTP 503');
    }
    if (b === 'CRASH') throw new Error('bug inesperado');
    if (b === 'REJECT')
      return {
        kind: 'REJECTED',
        errors: [{ code: 'E0625', message: 'Alíquota não deve ser informada' }],
      };
    if (b === 'DUPLICATE')
      return { kind: 'DUPLICATE', errors: [{ code: 'E0014', message: 'DPS já existente' }] };
    return { kind: 'ISSUED', nfse: sampleNfse(String(++this.counter)) };
  }
  /** Simula Sefin fora do ar para consultas/cancelamentos. */
  down = false;
  private async maybeDown() {
    if (!this.down) return;
    const { FiscalProviderUnavailableError } =
      await import('../../src/application/ports/fiscal-provider.js');
    throw new FiscalProviderUnavailableError('Sefin HTTP 503');
  }
  async findByDpsId(invoice: Invoice) {
    this.calls.push(`find:${invoice.id}`);
    await this.maybeDown();
    return this.existing;
  }
  async cancel(invoice: Invoice) {
    this.calls.push(`cancel:${invoice.id}`);
    await this.maybeDown();
    return this.cancelResult;
  }
}

export class InMemoryUsers implements UserRepository {
  readonly items = new Map<string, User>();
  async create(u: User) {
    if ([...this.items.values()].some((x) => x.externalId === u.externalId))
      throw new DomainError('CONFLICT', 'dup');
    this.items.set(u.id, copy(u));
  }
  async update(u: User) {
    this.items.set(u.id, copy(u));
  }
  async findById(id: string) {
    return copy(this.items.get(id) ?? null);
  }
  async findByExternalId(externalId: string) {
    return copy([...this.items.values()].find((u) => u.externalId === externalId) ?? null);
  }
  async findByTenant(tenantId: string) {
    return copy([...this.items.values()].filter((u) => u.tenantIds.includes(tenantId)));
  }
}

export class InMemoryCoverage implements CoverageRepository {
  readonly items = new Map<string, CityCoverage>();
  async get(cityCode: string) {
    return copy(this.items.get(cityCode) ?? null);
  }
  async upsert(c: CityCoverage) {
    this.items.set(c.cityCode, copy(c));
  }
  async list() {
    return copy([...this.items.values()]);
  }
}

export class InMemoryBilling implements BillingRepository {
  readonly charges = new Map<string, BillingCharge>();
  readonly accounts = new Map<string, BillingAccount>();
  readonly payments = new Map<string, BillingPayment>();
  async createCharge(c: BillingCharge) {
    if ([...this.charges.values()].some((x) => x.invoiceId === c.invoiceId)) return false;
    this.charges.set(c.id, copy(c));
    return true;
  }
  async findChargeByInvoice(invoiceId: string) {
    return copy([...this.charges.values()].find((c) => c.invoiceId === invoiceId) ?? null);
  }
  async findOpenCharges(tenantId: string) {
    return copy(
      [...this.charges.values()].filter((c) => c.tenantId === tenantId && c.status === 'OPEN')
    );
  }
  async listCharges(tenantId: string, p: { page?: number; pageSize?: number }) {
    return page(copy([...this.charges.values()].filter((c) => c.tenantId === tenantId)), p);
  }
  async markChargesPaid(ids: string[], paidAt: Date, settledBy: string) {
    for (const id of ids) {
      const c = this.charges.get(id);
      if (c?.status === 'OPEN') Object.assign(c, { status: 'PAID', paidAt, settledBy });
    }
  }
  async tenantsToReview() {
    const open = [...this.charges.values()]
      .filter((c) => c.status === 'OPEN')
      .map((c) => c.tenantId);
    const blocked = [...this.accounts.values()]
      .filter((a) => a.status === 'BLOCKED')
      .map((a) => a.tenantId);
    return [...new Set([...open, ...blocked])];
  }
  async usageByTenant(from: Date, to: Date) {
    const usage = new Map<string, BillingUsage>();
    for (const c of this.charges.values()) {
      if (c.createdAt < from || c.createdAt >= to || c.status === 'WAIVED' || c.amountCents <= 0)
        continue;
      const u = usage.get(c.tenantId) ?? { tenantId: c.tenantId, invoiceCount: 0, totalCents: 0 };
      usage.set(c.tenantId, {
        ...u,
        invoiceCount: u.invoiceCount + 1,
        totalCents: u.totalCents + c.amountCents,
      });
    }
    return [...usage.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  }
  async getAccount(tenantId: string) {
    return copy(this.accounts.get(tenantId) ?? null);
  }
  async saveAccount(a: BillingAccount) {
    this.accounts.set(a.tenantId, copy(a));
  }
  async listAccounts(status?: BillingAccount['status']) {
    return copy([...this.accounts.values()].filter((a) => !status || a.status === status));
  }
  async createPayment(p: BillingPayment) {
    this.payments.set(p.id, copy(p));
  }
  async updatePayment(p: BillingPayment) {
    this.payments.set(p.id, copy(p));
  }
  async findPayment(id: string) {
    return copy(this.payments.get(id) ?? null);
  }
  async findPaymentByProviderId(providerId: string) {
    return copy([...this.payments.values()].find((p) => p.providerId === providerId) ?? null);
  }
  async findPendingPayment(tenantId: string, now: Date) {
    return copy(
      [...this.payments.values()]
        .filter(
          (p) =>
            p.tenantId === tenantId && p.status === 'PENDING' && (!p.expiresAt || p.expiresAt > now)
        )
        .at(-1) ?? null
    );
  }
}

export class InMemoryPastSales implements PastSaleRepository {
  readonly items: PastSale[] = [];
  async upsertMany(sales: PastSale[]) {
    let inserted = 0;
    for (const sale of sales) {
      const existing = this.items.find(
        (x) => x.tenantId === sale.tenantId && x.externalId === sale.externalId
      );
      if (!existing) {
        this.items.push(copy(sale));
        inserted++;
      } else if (
        (sale.status === 'REFUNDED' || sale.status === 'IMPORTED') &&
        ['AVAILABLE', 'ALREADY_ISSUED'].includes(existing.status)
      ) {
        existing.status = sale.status;
        if (sale.saleId) existing.saleId = sale.saleId;
      }
    }
    return { inserted };
  }
  async list(tenantId: string, filter: { period?: string; status?: PastSale['status'][] }) {
    return copy(
      this.items.filter(
        (x) =>
          x.tenantId === tenantId &&
          (!filter.period || x.period === filter.period) &&
          (!filter.status || filter.status.includes(x.status))
      )
    );
  }
  async update(sale: PastSale) {
    const i = this.items.findIndex((x) => x.id === sale.id);
    this.items[i] = copy(sale);
  }
}
