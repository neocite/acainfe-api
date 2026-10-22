import { User } from '../../domain/account/user.js';
import { PastSale } from '../../domain/backfill/past-sale.js';
import { AccountantReport } from '../../domain/accounting/accountant-report.js';
import {
  BillingAccount,
  BillingCharge,
  BillingPayment,
  BillingUsage,
} from '../../domain/billing/billing.js';
import { Certificate } from '../../domain/certificate/certificate.js';
import { CityCoverage } from '../../domain/tenant/coverage.js';
import { CustomerRecord } from '../../domain/customer/customer-record.js';
import { Logo } from '../../domain/tenant/logo.js';
import { Invoice, InvoiceStatus } from '../../domain/invoice/invoice.js';
import { Product } from '../../domain/product/product.js';
import { Sale, SaleRefund, SaleSource } from '../../domain/sale/sale.js';
import { ApiKeyRecord, FiscalEnvironment, Tenant } from '../../domain/tenant/tenant.js';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Pagination {
  page?: number;
  pageSize?: number;
}

export interface TenantRepository {
  create(tenant: Tenant): Promise<void>;
  findById(id: string): Promise<Tenant | null>;
  findByCnpj(cnpj: string): Promise<Tenant | null>;
  findByApiKeyHash(hash: string): Promise<Tenant | null>;
  /** Registra o último uso da chave (atualização pontual, sem regravar a empresa). */
  touchApiKey(tenantId: string, hash: string, at: Date): Promise<void>;
  /** Registra uma chave antiga (só hash) no primeiro uso, se ainda não tiver registro. */
  adoptApiKey(tenantId: string, record: ApiKeyRecord): Promise<void>;
  update(tenant: Tenant): Promise<void>;
  /** Empresas com contador configurado para envio mensal. */
  findWithAccountantReport(): Promise<Tenant[]>;
  /** Empresas na lista de espera de um município (para liberar e avisar). */
  findWaitlisted(cityCode?: string): Promise<Tenant[]>;
  /** Grava série e último número usado (próximo = último + 1) e marca a numeração como confirmada. */
  setNumbering(
    tenantId: string,
    series: string,
    lastDpsNumber: number,
    confirmedAt: Date
  ): Promise<void>;
  /** Reserva atomicamente `count` números de DPS e devolve o primeiro. */
  /** Série e primeiro número lidos/incrementados no MESMO update atômico (a série pode mudar a qualquer momento). */
  reserveDpsNumbers(tenantId: string, count: number): Promise<{ first: number; series: string }>;
}

export interface CertificateRepository {
  /** Salva o novo certificado como ativo e desativa os anteriores do tenant. */
  saveActive(certificate: Certificate): Promise<void>;
  findActive(tenantId: string): Promise<Certificate | null>;
  listActiveExpiringBefore(date: Date): Promise<Certificate[]>;
}

export interface ProductFilter extends Pagination {
  search?: string;
  includeInactive?: boolean;
  /** Só produtos aguardando definição da tributação. */
  pendingTaxReview?: boolean;
}

export interface ProductRepository {
  create(product: Product): Promise<void>;
  update(product: Product): Promise<void>;
  findById(tenantId: string, id: string): Promise<Product | null>;
  findManyByIds(tenantId: string, ids: string[]): Promise<Product[]>;
  findManyByExternalIds(tenantId: string, externalIds: string[]): Promise<Product[]>;
  list(tenantId: string, filter: ProductFilter): Promise<Page<Product>>;
}

export interface SaleRepository {
  /** Lança `DomainError('CONFLICT')` se já existir venda com mesmo tenant+source+externalId. */
  create(sale: Sale): Promise<void>;
  findById(tenantId: string, id: string): Promise<Sale | null>;
  findManyByIds(tenantId: string, ids: string[]): Promise<Sale[]>;
  /** Idempotência por ambiente: a mesma venda pode existir em homologação e em produção. */
  findByExternalId(
    tenantId: string,
    source: SaleSource,
    externalId: string,
    environment: FiscalEnvironment
  ): Promise<Sale | null>;
  setInvoiceIds(saleId: string, invoiceIds: string[]): Promise<void>;
  /** Substitui a venda (usado ao liberar uma venda retida). */
  update(sale: Sale): Promise<void>;
  /** Vendas retidas aguardando produtos/tributação. */
  findHeld(tenantId?: string): Promise<Sale[]>;
  /** Grava o pedido de estorno só se ainda não houver um (idempotente). */
  setRefund(saleId: string, refund: SaleRefund): Promise<void>;
}

export interface CustomerFilter extends Pagination {
  search?: string;
}

export interface CustomerRepository {
  create(customer: CustomerRecord): Promise<void>;
  update(customer: CustomerRecord): Promise<void>;
  delete(tenantId: string, id: string): Promise<boolean>;
  findById(tenantId: string, id: string): Promise<CustomerRecord | null>;
  /** Procura cliente existente pela ordem: CPF/CNPJ, externalId, e-mail, telefone. */
  findMatch(
    tenantId: string,
    keys: { taxId?: string; externalId?: string; email?: string; phone?: string }
  ): Promise<CustomerRecord | null>;
  list(tenantId: string, filter: CustomerFilter): Promise<Page<CustomerRecord>>;
}

export interface LogoRepository {
  save(tenantId: string, logo: Logo): Promise<void>;
  find(tenantId: string): Promise<Logo | null>;
  delete(tenantId: string): Promise<void>;
}

export interface InvoiceFilter extends Pagination {
  status?: InvoiceStatus[];
  from?: Date;
  to?: Date;
  customerTaxId?: string;
  saleId?: string;
}

export interface InvoiceRepository {
  createMany(invoices: Invoice[]): Promise<void>;
  findById(tenantId: string, id: string): Promise<Invoice | null>;
  /** Busca sem tenant — uso exclusivo dos jobs internos. */
  findByIdInternal(id: string): Promise<Invoice | null>;
  /** Nota emitida por nós com este número na prefeitura. */
  findByNfseNumber(tenantId: string, number: string): Promise<Invoice | null>;
  list(tenantId: string, filter: InvoiceFilter): Promise<Page<Invoice>>;
  /**
   * Persistência com controle otimista: só grava se o status atual for `expectedStatus`.
   * Retorna false se outro worker já mudou a nota.
   */
  updateIfStatus(invoice: Invoice, expectedStatus: Invoice['status']): Promise<boolean>;
  update(invoice: Invoice): Promise<void>;
  /**
   * Grava atomicamente só a entrega de um canal (+ último evento do histórico).
   * Entregas de canais diferentes rodam em paralelo e não podem sobrescrever umas às outras.
   */
  saveDelivery(invoice: Invoice, channel: Invoice['deliveries'][number]['channel']): Promise<void>;
  findDue(now: Date, limit: number): Promise<Invoice[]>;
  findStuckProcessing(updatedBefore: Date, limit: number): Promise<Invoice[]>;
  findPendingDeliveries(updatedBefore: Date, limit: number): Promise<Invoice[]>;
  /** Outbox da cobrança: notas emitidas (com NFS-e) ainda sem cobrança registrada. */
  findUnbilled(limit: number): Promise<Invoice[]>;
  /** Marca atomicamente a nota como cobrada (não sobrescreve o resto do documento). */
  markBilled(invoiceId: string, chargeId: string): Promise<void>;
  findByTenantAndStatus(
    tenantId: string,
    status: Invoice['status'][],
    limit: number
  ): Promise<Invoice[]>;
  /** Notas com NFS-e autorizada no intervalo (inclui as canceladas depois) — fechamento contábil. */
  findIssuedBetween(tenantId: string, from: Date, to: Date): Promise<Invoice[]>;
}

export interface UserRepository {
  create(user: User): Promise<void>;
  update(user: User): Promise<void>;
  findById(id: string): Promise<User | null>;
  findByExternalId(externalId: string): Promise<User | null>;
  findByTenant(tenantId: string): Promise<User[]>;
  /** Usuários cadastrados a partir da data (régua de ativação e resumo diário). */
  listCreatedSince(since: Date): Promise<User[]>;
}

export interface CoverageRepository {
  get(cityCode: string): Promise<CityCoverage | null>;
  upsert(coverage: CityCoverage): Promise<void>;
  list(): Promise<CityCoverage[]>;
}

export interface BillingRepository {
  /** false se a nota já tinha cobrança (idempotência por invoiceId). */
  createCharge(charge: BillingCharge): Promise<boolean>;
  findChargeByInvoice(invoiceId: string): Promise<BillingCharge | null>;
  findOpenCharges(tenantId: string): Promise<BillingCharge[]>;
  listCharges(tenantId: string, pagination: Pagination): Promise<Page<BillingCharge>>;
  markChargesPaid(chargeIds: string[], paidAt: Date, settledBy: string): Promise<void>;
  /** Empresas com cobrança em aberto ou conta bloqueada (para o job diário). */
  tenantsToReview(): Promise<string[]>;
  /** Cobranças criadas em [from, to) por empresa, sem as dispensadas e sem valor zero. */
  usageByTenant(from: Date, to: Date): Promise<BillingUsage[]>;
  getAccount(tenantId: string): Promise<BillingAccount | null>;
  saveAccount(account: BillingAccount): Promise<void>;
  listAccounts(status?: BillingAccount['status']): Promise<BillingAccount[]>;
  createPayment(payment: BillingPayment): Promise<void>;
  updatePayment(payment: BillingPayment): Promise<void>;
  findPayment(id: string): Promise<BillingPayment | null>;
  findPaymentByProviderId(providerId: string): Promise<BillingPayment | null>;
  findPendingPayment(tenantId: string, now: Date): Promise<BillingPayment | null>;
}

export interface AccountantReportRepository {
  findByPeriod(tenantId: string, period: string): Promise<AccountantReport | null>;
  save(report: AccountantReport): Promise<void>;
  listByTenant(tenantId: string, limit: number): Promise<AccountantReport[]>;
}

export interface PastSaleRepository {
  /** Insere as novas (por tenant+externalId); nas existentes só atualiza para REFUNDED se estornou. */
  upsertMany(sales: PastSale[]): Promise<{ inserted: number }>;
  list(
    tenantId: string,
    filter: { period?: string; status?: PastSale['status'][] }
  ): Promise<PastSale[]>;
  update(sale: PastSale): Promise<void>;
}
