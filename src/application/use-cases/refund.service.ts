import {
  abortBeforeIssue,
  FiscalError,
  Invoice,
  markCancelled,
  nfseMatchesInvoice,
  recordCancellationFailure,
  syncIssued,
} from '../../domain/invoice/invoice.js';
import { requestRefund, Sale, SaleSource } from '../../domain/sale/sale.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import {
  FiscalProviderResolver,
  FiscalProviderUnavailableError,
} from '../ports/fiscal-provider.js';
import { InvoiceRepository, SaleRepository, TenantRepository } from '../ports/repositories.js';
import { Clock, JobScheduler, Logger } from '../ports/services.js';
import { CertificateService } from './certificate.service.js';

export type RefundOutcome =
  /** Cancelada na prefeitura. */
  | 'CANCELLED'
  /** Ainda não tinha sido emitida: encerrada sem emitir. */
  | 'CANCELLED_BEFORE_ISSUE'
  /** Em andamento (prefeitura indisponível ou nota sendo processada): será concluído pela fila. */
  | 'PENDING'
  /** A prefeitura recusou o cancelamento (ex.: prazo expirado) — exige ação manual. */
  | 'FAILED';

export interface InvoiceRefundResult {
  invoiceId: string;
  outcome: RefundOutcome;
  errors?: FiscalError[];
}

const RETRY_MS = 5 * 60_000;

/** Estorno de venda: cancela as NFS-e emitidas e impede a emissão das que ainda estão na fila. */
export class RefundService {
  constructor(
    private readonly deps: {
      sales: SaleRepository;
      invoices: InvoiceRepository;
      tenants: TenantRepository;
      certificates: CertificateService;
      providers: FiscalProviderResolver;
      scheduler: JobScheduler;
      clock: Clock;
      logger: Logger;
    }
  ) {}

  async refundSale(
    tenant: Tenant,
    target: { saleId?: string; externalId?: string; source?: SaleSource },
    params: { reasonCode?: '1' | '2' | '9'; reason?: string; requestedBy: SaleSource }
  ): Promise<{ sale: Sale; invoices: InvoiceRefundResult[] }> {
    const sale = target.saleId
      ? await this.deps.sales.findById(tenant.id, target.saleId)
      : target.externalId
        ? await this.deps.sales.findByExternalId(
            tenant.id,
            target.source ?? 'API',
            target.externalId,
            tenant.environment
          )
        : null;
    if (!sale)
      throw DomainError.notFound('Venda', target.saleId ?? target.externalId ?? '(não informada)');

    const refunded = requestRefund(
      sale,
      { ...params, source: params.requestedBy },
      this.deps.clock.now()
    );
    if (!sale.refund) await this.deps.sales.setRefund(sale.id, refunded.refund!);

    const invoices: InvoiceRefundResult[] = [];
    for (const invoiceId of sale.invoiceIds) invoices.push(await this.settle(invoiceId));
    return { sale: refunded, invoices };
  }

  /** Handler do job `refund-invoice` — também chamado diretamente no pedido de estorno. Idempotente. */
  async settle(invoiceId: string): Promise<InvoiceRefundResult> {
    const invoice = await this.deps.invoices.findByIdInternal(invoiceId);
    if (!invoice) throw DomainError.notFound('Nota', invoiceId);
    const sale = await this.deps.sales.findById(invoice.tenantId, invoice.saleId);
    const refund = sale?.refund;
    if (!refund) return { invoiceId, outcome: this.outcomeOf(invoice) };

    switch (invoice.status) {
      case 'CANCELLED':
        return { invoiceId, outcome: this.outcomeOf(invoice) };
      case 'PROCESSING':
        return this.later(invoiceId, 60_000);
      case 'ISSUED':
        return this.cancelAtProvider(invoice, refund.reasonCode, refund.reason);
      default:
        return this.abortOrCancel(invoice, refund.reasonCode, refund.reason);
    }
  }

  private async abortOrCancel(
    invoice: Invoice,
    reasonCode: string,
    reason: string
  ): Promise<InvoiceRefundResult> {
    const now = this.deps.clock.now();
    if (invoice.sentToProvider) {
      // Pode já existir na prefeitura (timeout após o envio): consulta antes de decidir.
      const tenant = await this.tenantOf(invoice);
      try {
        const material = await this.deps.certificates.loadMaterial(tenant);
        const found = await this.provider(invoice, tenant).findByDpsId(invoice, tenant, material);
        // Nota encontrada só conta se for desta venda (outra pode ter usado o mesmo número de DPS).
        if (found && nfseMatchesInvoice(found, invoice)) {
          const synced = syncIssued(invoice, found, now);
          if (!(await this.deps.invoices.updateIfStatus(synced, invoice.status)))
            return this.later(invoice.id);
          return this.cancelAtProvider(synced, reasonCode, reason);
        }
      } catch (error) {
        if (error instanceof FiscalProviderUnavailableError) return this.later(invoice.id);
        if (!(error instanceof DomainError)) throw error;
        // Sem certificado não há como consultar: se nunca foi autorizada, encerrar localmente é seguro o bastante.
      }
    }
    const aborted = abortBeforeIssue(invoice, `Venda estornada antes da emissão: ${reason}`, now);
    if (!(await this.deps.invoices.updateIfStatus(aborted, invoice.status)))
      return this.later(invoice.id);
    return { invoiceId: invoice.id, outcome: 'CANCELLED_BEFORE_ISSUE' };
  }

  private async cancelAtProvider(
    invoice: Invoice,
    reasonCode: string,
    reason: string
  ): Promise<InvoiceRefundResult> {
    const tenant = await this.tenantOf(invoice);
    const now = () => this.deps.clock.now();
    try {
      const material = await this.deps.certificates.loadMaterial(tenant);
      // Cancela no sistema que emitiu a nota, mesmo depois da virada para o nacional.
      const result = await this.provider(invoice, tenant).cancel(invoice, tenant, material, {
        code: reasonCode,
        description: reason,
      });
      if (result.ok) {
        await this.deps.invoices.updateIfStatus(
          markCancelled(invoice, reasonCode, reason, now()),
          'ISSUED'
        );
        return { invoiceId: invoice.id, outcome: 'CANCELLED' };
      }
      await this.deps.invoices.update(recordCancellationFailure(invoice, result.errors, now()));
      return { invoiceId: invoice.id, outcome: 'FAILED', errors: result.errors };
    } catch (error) {
      if (error instanceof FiscalProviderUnavailableError) return this.later(invoice.id);
      if (error instanceof DomainError) {
        const errors = [{ code: error.code, message: error.message }];
        await this.deps.invoices.update(recordCancellationFailure(invoice, errors, now()));
        return { invoiceId: invoice.id, outcome: 'FAILED', errors };
      }
      throw error;
    }
  }

  private async later(invoiceId: string, delayMs = RETRY_MS): Promise<InvoiceRefundResult> {
    await this.deps.scheduler
      .scheduleRefund(invoiceId, new Date(this.deps.clock.now().getTime() + delayMs))
      .catch((error: unknown) =>
        this.deps.logger.warn('Falha ao agendar estorno', { invoiceId, error: String(error) })
      );
    return { invoiceId, outcome: 'PENDING' };
  }

  private outcomeOf(invoice: Invoice): RefundOutcome {
    if (invoice.status !== 'CANCELLED') return invoice.cancellationErrors ? 'FAILED' : 'PENDING';
    return invoice.cancellation?.beforeIssue ? 'CANCELLED_BEFORE_ISSUE' : 'CANCELLED';
  }

  private provider(invoice: Invoice, tenant: Tenant) {
    return this.deps.providers.forInvoice?.(invoice, tenant) ?? this.deps.providers.resolve(tenant);
  }

  private async tenantOf(invoice: Invoice): Promise<Tenant> {
    const tenant = await this.deps.tenants.findById(invoice.tenantId);
    if (!tenant) throw DomainError.notFound('Empresa', invoice.tenantId);
    return tenant;
  }
}
