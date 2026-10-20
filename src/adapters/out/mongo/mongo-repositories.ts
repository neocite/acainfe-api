import { Binary, Collection, Db, MongoServerError } from 'mongodb';
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
  Pagination,
  ProductFilter,
  ProductRepository,
  SaleRepository,
  TenantRepository,
  UserRepository,
} from '../../../application/ports/repositories.js';
import { User } from '../../../domain/account/user.js';
import { PastSale } from '../../../domain/backfill/past-sale.js';
import { AccountantReport } from '../../../domain/accounting/accountant-report.js';
import { BillingAccount, BillingCharge, BillingPayment } from '../../../domain/billing/billing.js';
import { Certificate } from '../../../domain/certificate/certificate.js';
import { CityCoverage } from '../../../domain/tenant/coverage.js';
import { CustomerRecord } from '../../../domain/customer/customer-record.js';
import { Logo } from '../../../domain/tenant/logo.js';
import { Invoice } from '../../../domain/invoice/invoice.js';
import { Product } from '../../../domain/product/product.js';
import { Sale, SaleRefund, SaleSource } from '../../../domain/sale/sale.js';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { ApiKeyRecord, FiscalEnvironment, Tenant } from '../../../domain/tenant/tenant.js';

type Doc<T extends { id: string }> = Omit<T, 'id'> & { _id: string };

const toDoc = <T extends { id: string }>(entity: T): Doc<T> => {
  const { id, ...rest } = entity;
  return { _id: id, ...rest } as Doc<T>;
};

const fromDoc = <T extends { id: string }>(doc: Doc<T> | null): T | null => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest } as unknown as T;
};

/** Remove chaves com undefined — o driver gravaria null e quebraria a igualdade do domínio. */
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value), reviveDates) as T;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function reviveDates(_key: string, value: unknown): unknown {
  return typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value;
}

const isDuplicateKey = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === 11000;

function paginate(p: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
  skip: number;
} {
  const page = Math.max(1, Math.floor(p.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(p.pageSize ?? 20)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const COLLECTIONS = {
  tenants: 'tenants',
  certificates: 'certificates',
  products: 'products',
  sales: 'sales',
  invoices: 'invoices',
  customers: 'customers',
  logos: 'tenant_logos',
  users: 'users',
  coverage: 'city_coverage',
  billingCharges: 'billing_charges',
  billingAccounts: 'billing_accounts',
  billingPayments: 'billing_payments',
  accountantReports: 'accountant_reports',
  pastSales: 'past_sales',
} as const;

/**
 * Vendas e notas antigas não tinham ambiente: recebem o ambiente atual da empresa, e o índice único
 * de vendas passa a incluir o ambiente (a mesma venda pode existir em homologação e em produção).
 */
async function migrateEnvironment(db: Db): Promise<void> {
  await db
    .collection(COLLECTIONS.sales)
    .dropIndex('tenantId_1_source_1_externalId_1')
    .catch(() => undefined);
  const tenants = db.collection<{ _id: string; environment?: string }>(COLLECTIONS.tenants);
  for await (const t of tenants.find({}, { projection: { environment: 1 } })) {
    const environment = t.environment ?? 'HOMOLOGATION';
    for (const name of [COLLECTIONS.sales, COLLECTIONS.invoices]) {
      await db
        .collection(name)
        .updateMany(
          { tenantId: t._id, environment: { $exists: false } },
          { $set: { environment } }
        );
    }
  }
}

export async function ensureIndexes(db: Db): Promise<void> {
  await migrateEnvironment(db);
  const partialString = (field: string) => ({ [field]: { $type: 'string' } });
  await Promise.all([
    db
      .collection(COLLECTIONS.tenants)
      .createIndexes([
        { key: { cnpj: 1 }, unique: true },
        { key: { apiKeyHashes: 1 } },
        { key: { status: 1, cityCode: 1 } },
        { key: { 'accountant.monthlyReport': 1, status: 1 } },
      ]),
    db
      .collection(COLLECTIONS.users)
      .createIndexes([{ key: { externalId: 1 }, unique: true }, { key: { tenantIds: 1 } }]),
    db
      .collection(COLLECTIONS.certificates)
      .createIndexes([
        { key: { tenantId: 1, active: 1 } },
        { key: { active: 1, 'metadata.notAfter': 1 } },
      ]),
    db.collection(COLLECTIONS.products).createIndexes([
      {
        key: { tenantId: 1, externalId: 1 },
        unique: true,
        partialFilterExpression: partialString('externalId'),
      },
      { key: { tenantId: 1, name: 1 } },
      { key: { tenantId: 1, taxStatus: 1 } },
      { key: { tenantId: 1, aliasExternalIds: 1 } },
    ]),
    db.collection(COLLECTIONS.customers).createIndexes([
      {
        key: { tenantId: 1, 'taxId.value': 1 },
        unique: true,
        partialFilterExpression: partialString('taxId.value'),
      },
      {
        key: { tenantId: 1, externalId: 1 },
        unique: true,
        partialFilterExpression: partialString('externalId'),
      },
      { key: { tenantId: 1, email: 1 } },
      { key: { tenantId: 1, phone: 1 } },
      { key: { tenantId: 1, name: 1 } },
    ]),
    db.collection(COLLECTIONS.sales).createIndexes([
      {
        key: { tenantId: 1, source: 1, externalId: 1, environment: 1 },
        unique: true,
        name: 'sale_external_id_per_environment',
      },
      {
        key: { tenantId: 1, 'held.since': 1 },
        partialFilterExpression: { held: { $exists: true } },
      },
    ]),
    db
      .collection(COLLECTIONS.invoices)
      .createIndexes([
        { key: { tenantId: 1, createdAt: -1 } },
        { key: { tenantId: 1, saleId: 1 } },
        { key: { tenantId: 1, 'customer.taxId.value': 1 } },
        { key: { tenantId: 1, status: 1 } },
        { key: { tenantId: 1, 'nfse.issuedAt': 1 } },
        { key: { status: 1, nextAttemptAt: 1 } },
        { key: { status: 1, updatedAt: 1 } },
        { key: { 'deliveries.status': 1 } },
        { key: { billedChargeId: 1, 'nfse.accessKey': 1 } },
      ]),
    db.collection(COLLECTIONS.billingCharges).createIndexes([
      // Garante no máximo uma cobrança por nota (idempotência do outbox).
      { key: { invoiceId: 1 }, unique: true },
      { key: { tenantId: 1, status: 1, createdAt: 1 } },
    ]),
    db.collection(COLLECTIONS.billingAccounts).createIndexes([{ key: { status: 1 } }]),
    db.collection(COLLECTIONS.billingPayments).createIndexes([
      {
        key: { providerId: 1 },
        unique: true,
        partialFilterExpression: partialString('providerId'),
      },
      { key: { tenantId: 1, status: 1 } },
    ]),
    db
      .collection(COLLECTIONS.pastSales)
      .createIndexes([
        { key: { tenantId: 1, externalId: 1 }, unique: true },
        { key: { tenantId: 1, period: 1, status: 1 } },
      ]),
    db
      .collection(COLLECTIONS.accountantReports)
      .createIndexes([{ key: { tenantId: 1, period: 1 }, unique: true }]),
  ]);
}

export class MongoTenantRepository implements TenantRepository {
  private readonly col: Collection<Doc<Tenant>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.tenants);
  }

  async create(tenant: Tenant): Promise<void> {
    try {
      await this.col.insertOne(clean(toDoc(tenant)));
    } catch (error) {
      if (isDuplicateKey(error))
        throw new DomainError('CONFLICT', 'CNPJ já cadastrado', { cnpj: tenant.cnpj });
      throw error;
    }
  }
  async findById(id: string) {
    return fromDoc<Tenant>(await this.col.findOne({ _id: id }));
  }
  async findByCnpj(cnpj: string) {
    return fromDoc<Tenant>(await this.col.findOne({ cnpj }));
  }
  async adoptApiKey(tenantId: string, record: ApiKeyRecord) {
    await this.col.updateOne(
      { _id: tenantId, apiKeyHashes: record.hash, 'apiKeys.hash': { $ne: record.hash } },
      { $push: { apiKeys: clean(record) as never } }
    );
  }
  async touchApiKey(tenantId: string, hash: string, at: Date) {
    await this.col.updateOne(
      { _id: tenantId, 'apiKeys.hash': hash },
      { $set: { 'apiKeys.$.lastUsedAt': at } }
    );
  }
  async findByApiKeyHash(hash: string) {
    return fromDoc<Tenant>(await this.col.findOne({ apiKeyHashes: hash }));
  }
  async update(tenant: Tenant): Promise<void> {
    // lastDpsNumber nunca é sobrescrito por update genérico — só pelo $inc atômico.
    const { lastDpsNumber: _ignored, _id, ...doc } = clean(toDoc(tenant));
    await this.col.updateOne({ _id }, { $set: doc });
  }
  async setNumbering(tenantId: string, series: string, lastDpsNumber: number, confirmedAt: Date) {
    await this.col.updateOne(
      { _id: tenantId },
      {
        $set: {
          dpsSeries: series,
          lastDpsNumber,
          numberingConfirmedAt: confirmedAt,
          updatedAt: confirmedAt,
        },
      }
    );
  }
  async findWithAccountantReport() {
    const docs = await this.col
      .find({ 'accountant.monthlyReport': true, status: 'ACTIVE' })
      .toArray();
    return docs.map((d) => fromDoc<Tenant>(d)!);
  }
  async findWaitlisted(cityCode?: string) {
    const docs = await this.col
      .find({ status: 'WAITLIST', ...(cityCode ? { cityCode } : {}) })
      .toArray();
    return docs.map((d) => fromDoc<Tenant>(d)!);
  }
  async reserveDpsNumbers(tenantId: string, count: number) {
    const result = await this.col.findOneAndUpdate(
      { _id: tenantId },
      { $inc: { lastDpsNumber: count } },
      { returnDocument: 'after', projection: { lastDpsNumber: 1, dpsSeries: 1 } }
    );
    if (!result) throw DomainError.notFound('Empresa', tenantId);
    return { first: result.lastDpsNumber - count + 1, series: result.dpsSeries };
  }
}

export class MongoCertificateRepository implements CertificateRepository {
  private readonly col: Collection<Doc<Certificate>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.certificates);
  }
  async saveActive(certificate: Certificate): Promise<void> {
    await this.col.insertOne(clean(toDoc(certificate)));
    await this.col.updateMany(
      { tenantId: certificate.tenantId, active: true, _id: { $ne: certificate.id } },
      { $set: { active: false } }
    );
  }
  async findActive(tenantId: string) {
    return fromDoc<Certificate>(
      await this.col.findOne({ tenantId, active: true }, { sort: { createdAt: -1 } })
    );
  }
  async listActiveExpiringBefore(date: Date) {
    const docs = await this.col
      .find({ active: true, 'metadata.notAfter': { $lte: date } })
      .toArray();
    return docs.map((d) => fromDoc<Certificate>(d)!);
  }
}

export class MongoProductRepository implements ProductRepository {
  private readonly col: Collection<Doc<Product>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.products);
  }
  async create(product: Product): Promise<void> {
    try {
      await this.col.insertOne(clean(toDoc(product)));
    } catch (error) {
      if (isDuplicateKey(error))
        throw new DomainError('CONFLICT', `externalId já usado: ${product.externalId}`);
      throw error;
    }
  }
  async update(product: Product): Promise<void> {
    await this.col.replaceOne(
      { _id: product.id, tenantId: product.tenantId },
      clean(toDoc(product))
    );
  }
  async findById(tenantId: string, id: string) {
    return fromDoc<Product>(await this.col.findOne({ _id: id, tenantId }));
  }
  async findManyByIds(tenantId: string, ids: string[]) {
    return (await this.col.find({ tenantId, _id: { $in: ids } }).toArray()).map((d) =>
      fromDoc<Product>(d)!
    );
  }
  async findManyByExternalIds(tenantId: string, externalIds: string[]) {
    if (!externalIds.length) return [];
    const docs = await this.col
      .find({
        tenantId,
        $or: [{ externalId: { $in: externalIds } }, { aliasExternalIds: { $in: externalIds } }],
      })
      .toArray();
    return docs.map((d) => fromDoc<Product>(d)!);
  }
  async list(tenantId: string, filter: ProductFilter): Promise<Page<Product>> {
    const { page, pageSize, skip } = paginate(filter);
    const query: Record<string, unknown> = { tenantId };
    if (!filter.includeInactive) query.active = true;
    if (filter.pendingTaxReview) query.taxStatus = 'PENDING_REVIEW';
    if (filter.search) {
      const re = new RegExp(escapeRegex(filter.search), 'i');
      query.$or = [{ name: re }, { externalId: re }, { 'taxProfile.nationalServiceCode': re }];
    }
    const [docs, total] = await Promise.all([
      this.col.find(query).sort({ name: 1 }).skip(skip).limit(pageSize).toArray(),
      this.col.countDocuments(query),
    ]);
    return { items: docs.map((d) => fromDoc<Product>(d)!), total, page, pageSize };
  }
}

export class MongoSaleRepository implements SaleRepository {
  private readonly col: Collection<Doc<Sale>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.sales);
  }
  async create(sale: Sale): Promise<void> {
    try {
      await this.col.insertOne({
        ...clean(toDoc({ ...sale, rawPayload: undefined })),
        rawPayload: sale.rawPayload,
      } as Doc<Sale>);
    } catch (error) {
      if (isDuplicateKey(error))
        throw new DomainError('CONFLICT', 'Venda já registrada', { externalId: sale.externalId });
      throw error;
    }
  }
  async findById(tenantId: string, id: string) {
    return fromDoc<Sale>(await this.col.findOne({ _id: id, tenantId }));
  }
  async findManyByIds(tenantId: string, ids: string[]) {
    if (!ids.length) return [];
    const docs = await this.col
      .find({ tenantId, _id: { $in: ids } }, { projection: { rawPayload: 0 } })
      .toArray();
    return docs.map((d) => fromDoc<Sale>(d)!);
  }
  async findByExternalId(
    tenantId: string,
    source: SaleSource,
    externalId: string,
    environment: FiscalEnvironment
  ) {
    return fromDoc<Sale>(await this.col.findOne({ tenantId, source, externalId, environment }));
  }
  async setInvoiceIds(saleId: string, invoiceIds: string[]): Promise<void> {
    await this.col.updateOne({ _id: saleId }, { $set: { invoiceIds } });
  }
  async update(sale: Sale): Promise<void> {
    const { rawPayload, ...rest } = sale;
    await this.col.replaceOne({ _id: sale.id }, {
      ...clean(toDoc({ ...rest, id: sale.id } as Sale)),
      rawPayload,
    } as Doc<Sale>);
  }
  async findHeld(tenantId?: string) {
    const docs = await this.col
      .find({ held: { $exists: true }, ...(tenantId ? { tenantId } : {}) })
      .sort({ 'held.since': 1 })
      .limit(200)
      .toArray();
    return docs.map((d) => fromDoc<Sale>(d)!);
  }
  async setRefund(saleId: string, refund: SaleRefund): Promise<void> {
    await this.col.updateOne(
      { _id: saleId, refund: { $exists: false } },
      { $set: { refund: clean(refund) } }
    );
  }
}

export class MongoCustomerRepository implements CustomerRepository {
  private readonly col: Collection<Doc<CustomerRecord>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.customers);
  }
  async create(customer: CustomerRecord): Promise<void> {
    try {
      await this.col.insertOne(clean(toDoc(customer)));
    } catch (error) {
      if (isDuplicateKey(error))
        throw new DomainError('CONFLICT', 'Cliente já cadastrado (CPF/CNPJ ou externalId)');
      throw error;
    }
  }
  async update(customer: CustomerRecord): Promise<void> {
    await this.col.replaceOne(
      { _id: customer.id, tenantId: customer.tenantId },
      clean(toDoc(customer))
    );
  }
  async delete(tenantId: string, id: string): Promise<boolean> {
    return (await this.col.deleteOne({ _id: id, tenantId })).deletedCount === 1;
  }
  async findById(tenantId: string, id: string) {
    return fromDoc<CustomerRecord>(await this.col.findOne({ _id: id, tenantId }));
  }
  async findMatch(
    tenantId: string,
    keys: { taxId?: string; externalId?: string; email?: string; phone?: string }
  ) {
    const order: [string, string | undefined][] = [
      ['taxId.value', keys.taxId],
      ['externalId', keys.externalId],
      ['email', keys.email],
      ['phone', keys.phone],
    ];
    for (const [field, value] of order) {
      if (!value) continue;
      const found = await this.col.findOne({ tenantId, [field]: value } as never);
      if (found) return fromDoc<CustomerRecord>(found);
    }
    return null;
  }
  async list(tenantId: string, filter: CustomerFilter): Promise<Page<CustomerRecord>> {
    const { page, pageSize, skip } = paginate(filter);
    const query: Record<string, unknown> = { tenantId };
    if (filter.search) {
      const re = new RegExp(escapeRegex(filter.search), 'i');
      const digits = filter.search.replace(/\D/g, '');
      query.$or = [
        { name: re },
        { email: re },
        { externalId: re },
        ...(digits ? [{ 'taxId.value': new RegExp(digits) }, { phone: new RegExp(digits) }] : []),
      ];
    }
    const [docs, total] = await Promise.all([
      this.col.find(query).sort({ name: 1 }).skip(skip).limit(pageSize).toArray(),
      this.col.countDocuments(query),
    ]);
    return { items: docs.map((d) => fromDoc<CustomerRecord>(d)!), total, page, pageSize };
  }
}

export class MongoLogoRepository implements LogoRepository {
  private readonly col: Collection<{ _id: string; contentType: Logo['contentType']; data: Binary }>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.logos);
  }
  async save(tenantId: string, logo: Logo): Promise<void> {
    await this.col.replaceOne(
      { _id: tenantId },
      { contentType: logo.contentType, data: new Binary(logo.data) },
      { upsert: true }
    );
  }
  async find(tenantId: string): Promise<Logo | null> {
    const doc = await this.col.findOne({ _id: tenantId });
    return doc ? { contentType: doc.contentType, data: Buffer.from(doc.data.buffer) } : null;
  }
  async delete(tenantId: string): Promise<void> {
    await this.col.deleteOne({ _id: tenantId });
  }
}

export class MongoInvoiceRepository implements InvoiceRepository {
  private readonly col: Collection<Doc<Invoice>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.invoices);
  }
  async createMany(invoices: Invoice[]): Promise<void> {
    if (invoices.length) await this.col.insertMany(invoices.map((i) => clean(toDoc(i))));
  }
  async findById(tenantId: string, id: string) {
    return fromDoc<Invoice>(await this.col.findOne({ _id: id, tenantId }));
  }
  async findByIdInternal(id: string) {
    return fromDoc<Invoice>(await this.col.findOne({ _id: id }));
  }
  async list(tenantId: string, filter: InvoiceFilter): Promise<Page<Invoice>> {
    const { page, pageSize, skip } = paginate(filter);
    const query: Record<string, unknown> = { tenantId };
    if (filter.status?.length) query.status = { $in: filter.status };
    if (filter.saleId) query.saleId = filter.saleId;
    if (filter.customerTaxId)
      query['customer.taxId.value'] = filter.customerTaxId.replace(/\D/g, '');
    if (filter.from || filter.to) {
      query.createdAt = {
        ...(filter.from && { $gte: filter.from }),
        ...(filter.to && { $lte: filter.to }),
      };
    }
    const [docs, total] = await Promise.all([
      this.col
        .find(query, { projection: { 'nfse.xml': 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray(),
      this.col.countDocuments(query),
    ]);
    return { items: docs.map((d) => fromDoc<Invoice>(d)!), total, page, pageSize };
  }
  async updateIfStatus(invoice: Invoice, expectedStatus: Invoice['status']): Promise<boolean> {
    const result = await this.col.replaceOne(
      { _id: invoice.id, status: expectedStatus },
      clean(toDoc(invoice))
    );
    return result.modifiedCount === 1 || result.matchedCount === 1;
  }
  async update(invoice: Invoice): Promise<void> {
    await this.col.replaceOne({ _id: invoice.id }, clean(toDoc(invoice)));
  }
  async saveDelivery(
    invoice: Invoice,
    channel: Invoice['deliveries'][number]['channel']
  ): Promise<void> {
    const delivery = invoice.deliveries.find((d) => d.channel === channel);
    if (!delivery) return;
    const last = invoice.history.at(-1);
    const current = await this.col.findOne({ _id: invoice.id }, { projection: { deliveries: 1 } });
    const exists = current?.deliveries?.some((d) => d.channel === channel);
    await this.col.updateOne(
      { _id: invoice.id },
      {
        ...(exists
          ? { $set: { 'deliveries.$[d]': clean(delivery), updatedAt: invoice.updatedAt } }
          : { $set: { updatedAt: invoice.updatedAt }, $push: { deliveries: clean(delivery) } }),
        ...(last && last.at.getTime() === invoice.updatedAt.getTime()
          ? { $push: { history: { $each: [clean(last)], $slice: -100 } } }
          : {}),
      } as never,
      exists ? { arrayFilters: [{ 'd.channel': channel }] } : {}
    );
  }

  async findDue(now: Date, limit: number) {
    const docs = await this.col
      .find({
        $or: [
          { status: 'PENDING', updatedAt: { $lte: new Date(now.getTime() - 60_000) } },
          { status: 'RETRYING', nextAttemptAt: { $lte: now } },
        ],
      })
      .limit(limit)
      .toArray();
    return docs.map((d) => fromDoc<Invoice>(d)!);
  }
  async findStuckProcessing(updatedBefore: Date, limit: number) {
    const docs = await this.col
      .find({ status: 'PROCESSING', updatedAt: { $lte: updatedBefore } })
      .limit(limit)
      .toArray();
    return docs.map((d) => fromDoc<Invoice>(d)!);
  }
  async findUnbilled(limit: number) {
    const docs = await this.col
      .find({
        'nfse.accessKey': { $exists: true },
        billedChargeId: { $exists: false },
        environment: { $ne: 'HOMOLOGATION' },
      })
      .limit(limit)
      .toArray();
    return docs.map((d) => fromDoc<Invoice>(d)!);
  }
  async markBilled(invoiceId: string, chargeId: string): Promise<void> {
    await this.col.updateOne({ _id: invoiceId }, { $set: { billedChargeId: chargeId } });
  }
  async findByTenantAndStatus(tenantId: string, status: Invoice['status'][], limit: number) {
    const docs = await this.col
      .find({ tenantId, status: { $in: status } })
      .limit(limit)
      .toArray();
    return docs.map((d) => fromDoc<Invoice>(d)!);
  }
  async findByNfseNumber(tenantId: string, number: string) {
    return fromDoc<Invoice>(await this.col.findOne({ tenantId, 'nfse.number': number }));
  }
  async findIssuedBetween(tenantId: string, from: Date, to: Date) {
    const docs = await this.col
      .find({ tenantId, 'nfse.issuedAt': { $gte: from, $lt: to } })
      .sort({ 'nfse.issuedAt': 1 })
      .toArray();
    return docs.map((d) => fromDoc<Invoice>(d)!);
  }
  async findPendingDeliveries(updatedBefore: Date, limit: number) {
    const docs = await this.col
      .find({ 'deliveries.status': 'PENDING', updatedAt: { $lte: updatedBefore } })
      .limit(limit)
      .toArray();
    return docs.map((d) => fromDoc<Invoice>(d)!);
  }
}

export class MongoUserRepository implements UserRepository {
  private readonly col: Collection<Doc<User>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.users);
  }
  async create(user: User): Promise<void> {
    try {
      await this.col.insertOne(clean(toDoc(user)));
    } catch (error) {
      if (isDuplicateKey(error)) throw new DomainError('CONFLICT', 'Usuário já cadastrado');
      throw error;
    }
  }
  async update(user: User): Promise<void> {
    await this.col.replaceOne({ _id: user.id }, clean(toDoc(user)));
  }
  async findById(id: string) {
    return fromDoc<User>(await this.col.findOne({ _id: id }));
  }
  async findByExternalId(externalId: string) {
    return fromDoc<User>(await this.col.findOne({ externalId }));
  }
  async findByTenant(tenantId: string) {
    return (await this.col.find({ tenantIds: tenantId }).toArray()).map((d) => fromDoc<User>(d)!);
  }
}

export class MongoCoverageRepository implements CoverageRepository {
  private readonly col: Collection<CityCoverage & { _id: string }>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.coverage);
  }
  async get(cityCode: string): Promise<CityCoverage | null> {
    const doc = await this.col.findOne({ _id: cityCode });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  }
  async upsert(coverage: CityCoverage): Promise<void> {
    await this.col.replaceOne({ _id: coverage.cityCode }, clean(coverage), { upsert: true });
  }
  async list(): Promise<CityCoverage[]> {
    return (await this.col.find().sort({ cityName: 1 }).toArray()).map(({ _id, ...rest }) => rest);
  }
}

export class MongoBillingRepository implements BillingRepository {
  private readonly charges: Collection<Doc<BillingCharge>>;
  private readonly accounts: Collection<BillingAccount & { _id: string }>;
  private readonly payments: Collection<Doc<BillingPayment>>;
  constructor(db: Db) {
    this.charges = db.collection(COLLECTIONS.billingCharges);
    this.accounts = db.collection(COLLECTIONS.billingAccounts);
    this.payments = db.collection(COLLECTIONS.billingPayments);
  }
  async createCharge(charge: BillingCharge): Promise<boolean> {
    try {
      await this.charges.insertOne(clean(toDoc(charge)));
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }
  async findChargeByInvoice(invoiceId: string) {
    return fromDoc<BillingCharge>(await this.charges.findOne({ invoiceId }));
  }
  async findOpenCharges(tenantId: string) {
    const docs = await this.charges
      .find({ tenantId, status: 'OPEN' })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map((d) => fromDoc<BillingCharge>(d)!);
  }
  async listCharges(tenantId: string, pagination: Pagination): Promise<Page<BillingCharge>> {
    const { page, pageSize, skip } = paginate(pagination);
    const [docs, total] = await Promise.all([
      this.charges.find({ tenantId }).sort({ createdAt: -1 }).skip(skip).limit(pageSize).toArray(),
      this.charges.countDocuments({ tenantId }),
    ]);
    return { items: docs.map((d) => fromDoc<BillingCharge>(d)!), total, page, pageSize };
  }
  async markChargesPaid(chargeIds: string[], paidAt: Date, settledBy: string): Promise<void> {
    if (!chargeIds.length) return;
    await this.charges.updateMany(
      { _id: { $in: chargeIds }, status: 'OPEN' },
      { $set: { status: 'PAID', paidAt, settledBy } }
    );
  }
  async tenantsToReview(): Promise<string[]> {
    const [open, blocked] = await Promise.all([
      this.charges.distinct('tenantId', { status: 'OPEN' }),
      this.accounts.distinct('_id', { status: 'BLOCKED' }),
    ]);
    return [...new Set([...open, ...blocked].map(String))];
  }
  async getAccount(tenantId: string): Promise<BillingAccount | null> {
    const doc = await this.accounts.findOne({ _id: tenantId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  }
  async saveAccount(account: BillingAccount): Promise<void> {
    await this.accounts.replaceOne({ _id: account.tenantId }, clean(account), { upsert: true });
  }
  async listAccounts(status?: BillingAccount['status']) {
    return (await this.accounts.find(status ? { status } : {}).toArray()).map(
      ({ _id, ...rest }) => rest
    );
  }
  async createPayment(payment: BillingPayment): Promise<void> {
    await this.payments.insertOne(clean(toDoc(payment)));
  }
  async updatePayment(payment: BillingPayment): Promise<void> {
    await this.payments.replaceOne({ _id: payment.id }, clean(toDoc(payment)));
  }
  async findPayment(id: string) {
    return fromDoc<BillingPayment>(await this.payments.findOne({ _id: id }));
  }
  async findPaymentByProviderId(providerId: string) {
    return fromDoc<BillingPayment>(await this.payments.findOne({ providerId }));
  }
  async findPendingPayment(tenantId: string, now: Date) {
    return fromDoc<BillingPayment>(
      await this.payments.findOne(
        { tenantId, status: 'PENDING', expiresAt: { $gt: now } },
        { sort: { createdAt: -1 } }
      )
    );
  }
}

export class MongoAccountantReportRepository implements AccountantReportRepository {
  private readonly col: Collection<Doc<AccountantReport>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.accountantReports);
  }
  async findByPeriod(tenantId: string, period: string) {
    return fromDoc<AccountantReport>(await this.col.findOne({ tenantId, period }));
  }
  /** Um registro por empresa e mês: um reenvio manual substitui o anterior. */
  async save(report: AccountantReport): Promise<void> {
    const { _id, ...rest } = clean(toDoc(report));
    await this.col.updateOne(
      { tenantId: report.tenantId, period: report.period },
      { $set: rest, $setOnInsert: { _id } },
      { upsert: true }
    );
  }
  async listByTenant(tenantId: string, limit: number) {
    const docs = await this.col.find({ tenantId }).sort({ period: -1 }).limit(limit).toArray();
    return docs.map((d) => fromDoc<AccountantReport>(d)!);
  }
}

export class MongoPastSaleRepository implements PastSaleRepository {
  private readonly col: Collection<Doc<PastSale>>;
  constructor(db: Db) {
    this.col = db.collection(COLLECTIONS.pastSales);
  }
  async upsertMany(sales: PastSale[]): Promise<{ inserted: number }> {
    let inserted = 0;
    for (const sale of sales) {
      const { _id, status, ...rest } = clean(toDoc(sale));
      const result = await this.col.updateOne(
        { tenantId: sale.tenantId, externalId: sale.externalId },
        { $setOnInsert: { _id, ...rest, status } },
        { upsert: true }
      );
      if (result.upsertedCount) inserted++;
      else if (status === 'REFUNDED' || status === 'IMPORTED') {
        // Estorno posterior ou venda que já virou nota por outro caminho (webhook): reflete na prévia.
        await this.col.updateOne(
          {
            tenantId: sale.tenantId,
            externalId: sale.externalId,
            status: { $in: ['AVAILABLE', 'ALREADY_ISSUED'] },
          },
          {
            $set: {
              status,
              ...(sale.saleId ? { saleId: sale.saleId } : {}),
              updatedAt: sale.updatedAt,
            },
          }
        );
      }
    }
    return { inserted };
  }
  async list(tenantId: string, filter: { period?: string; status?: PastSale['status'][] }) {
    const query = {
      tenantId,
      ...(filter.period ? { period: filter.period } : {}),
      ...(filter.status ? { status: { $in: filter.status } } : {}),
    };
    const docs = await this.col.find(query).sort({ paidAt: 1 }).toArray();
    return docs.map((d) => fromDoc<PastSale>(d)!);
  }
  async update(sale: PastSale): Promise<void> {
    await this.col.replaceOne({ _id: sale.id, tenantId: sale.tenantId }, clean(toDoc(sale)));
  }
}
