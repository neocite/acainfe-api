import {
  AWAITING_APPROVAL,
  buildDpsId,
  DeliveryChannel,
  DPS_NUMBER_CONFLICT,
  IssuedNfse,
  nfseMatchesInvoice,
  renumber,
  FiscalError,
  Invoice,
  markCancelled,
  markIssued,
  markRejected,
  markTransientFailure,
  prepareDelivery,
  recordDelivery,
  recoverStuck,
  requeue,
  startProcessing,
} from '../../domain/invoice/invoice.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { formatBRL } from '../../domain/shared/money.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import {
  FiscalProviderResolver,
  FiscalProviderUnavailableError,
} from '../ports/fiscal-provider.js';
import {
  InvoiceFilter,
  InvoiceRepository,
  LogoRepository,
  Page,
  SaleRepository,
  TenantRepository,
} from '../ports/repositories.js';
import {
  Clock,
  DanfseRenderer,
  DocumentLinks,
  EmailSender,
  JobScheduler,
  Logger,
  WhatsappSender,
} from '../ports/services.js';
import { CertificateService } from './certificate.service.js';
import { explainFiscalErrors } from './fiscal-error-hints.js';

const MAX_DELIVERY_ATTEMPTS = 5;
const STUCK_AFTER_MS = 10 * 60_000;

export const CANCELLATION_REASONS: Record<string, string> = {
  '1': 'Erro na emissão',
  '2': 'Serviço não prestado',
  '9': 'Outros',
};

export class InvoiceService {
  constructor(
    private readonly deps: {
      invoices: InvoiceRepository;
      tenants: TenantRepository;
      sales: SaleRepository;
      logos: LogoRepository;
      certificates: CertificateService;
      /** Pausa por inadimplência (cobrança interna do açaínfe). */
      billing: { isBlocked(tenantId: string): Promise<boolean> };
      providers: FiscalProviderResolver;
      scheduler: JobScheduler;
      renderer: DanfseRenderer;
      email: EmailSender;
      whatsapp: WhatsappSender;
      links: DocumentLinks;
      clock: Clock;
      logger: Logger;
    }
  ) {}

  // ---------- Consultas ----------

  async get(tenantId: string, id: string): Promise<Invoice> {
    const invoice = await this.deps.invoices.findById(tenantId, id);
    if (!invoice) throw DomainError.notFound('Nota', id);
    return invoice;
  }

  async getInternal(id: string): Promise<Invoice> {
    const invoice = await this.deps.invoices.findByIdInternal(id);
    if (!invoice) throw DomainError.notFound('Nota', id);
    return invoice;
  }

  list(tenantId: string, filter: InvoiceFilter): Promise<Page<Invoice>> {
    return this.deps.invoices.list(tenantId, filter);
  }

  async pdf(tenant: Tenant, id: string): Promise<Buffer> {
    const invoice = await this.get(tenant.id, id);
    if (!invoice.nfse)
      throw DomainError.invalidState('A nota ainda não foi emitida', { status: invoice.status });
    return this.render(invoice, tenant);
  }

  private async render(invoice: Invoice, tenant: Tenant): Promise<Buffer> {
    const logo = await this.deps.logos.find(tenant.id);
    return this.deps.renderer.render(invoice, tenant, { logo: logo ?? undefined });
  }

  private async refundRequested(invoice: Invoice): Promise<boolean> {
    return Boolean((await this.deps.sales.findById(invoice.tenantId, invoice.saleId))?.refund);
  }

  async explain(
    tenantId: string,
    id: string
  ): Promise<{ status: Invoice['status']; errors: FiscalError[]; hints: string[] }> {
    const invoice = await this.get(tenantId, id);
    const errors = invoice.lastErrors ?? [];
    return { status: invoice.status, errors, hints: explainFiscalErrors(errors) };
  }

  // ---------- Emissão (job) ----------

  /** Handler do job `issue-invoice`. Idempotente: pode ser chamado várias vezes para a mesma nota. */
  async issue(invoiceId: string): Promise<Invoice | null> {
    const current = await this.deps.invoices.findByIdInternal(invoiceId);
    if (!current || !['PENDING', 'RETRYING'].includes(current.status)) return current;
    const now = this.deps.clock.now();
    if (current.status === 'RETRYING' && current.nextAttemptAt && current.nextAttemptAt > now)
      return current;
    if (await this.deps.billing.isBlocked(current.tenantId)) {
      // Emissão pausada por saldo vencido: a nota fica na fila e sai quando o pagamento for confirmado.
      if (current.lastErrors?.[0]?.code !== 'BILLING_BLOCKED') {
        await this.deps.invoices.updateIfStatus(
          {
            ...current,
            lastErrors: [
              {
                code: 'BILLING_BLOCKED',
                message:
                  'Emissão pausada: há saldo em aberto no açaínfe além do prazo. A nota será emitida assim que o pagamento for confirmado.',
              },
            ],
            history: [...current.history, { at: now, event: 'BILLING_BLOCKED' }].slice(-100),
            updatedAt: now,
          },
          current.status
        );
      }
      return current;
    }
    if (await this.refundRequested(current)) {
      // Venda estornada antes da emissão: o fluxo de estorno decide (encerrar ou cancelar se já existir).
      await this.deps.scheduler.scheduleRefund(current.id).catch(() => undefined);
      return current;
    }

    const tenant = await this.deps.tenants.findById(current.tenantId);
    if (!tenant) throw DomainError.notFound('Empresa', current.tenantId);
    const provider = this.deps.providers.resolve(tenant);
    if (provider.requiresApproval && !current.approval) {
      // Modo piloto: espera o usuário conferir a prévia (preview_invoice) e liberar (approve_invoice).
      if (current.lastErrors?.[0]?.code !== AWAITING_APPROVAL) {
        await this.deps.invoices.updateIfStatus(
          {
            ...current,
            lastErrors: [
              {
                code: AWAITING_APPROVAL,
                message: `Integração ${provider.name} em modo piloto: confira a prévia da nota e aprove o envio à prefeitura.`,
              },
            ],
            history: [...current.history, { at: now, event: AWAITING_APPROVAL }].slice(-100),
            updatedAt: now,
          },
          current.status
        );
      }
      return current;
    }

    const processing = startProcessing(current, now);
    if (!(await this.deps.invoices.updateIfStatus(processing, current.status))) return null; // outro worker pegou

    let material;
    try {
      material = await this.deps.certificates.loadMaterial(tenant);
    } catch (error) {
      if (error instanceof DomainError) {
        return this.persist(
          markRejected(
            processing,
            [{ code: error.code, message: error.message }],
            this.deps.clock.now()
          )
        );
      }
      throw error;
    }

    try {
      // Tentativas anteriores podem ter chegado à Sefin sem resposta: consulta antes de reenviar.
      if (current.sentToProvider) {
        const already = await provider.findByDpsId(processing, tenant, material);
        if (already) {
          if (!nfseMatchesInvoice(already, processing))
            return this.onNumberConflict(processing, already);
          return this.onIssued(
            markIssued(processing, already, tenant.notifications, this.deps.clock.now())
          );
        }
      }
      const outcome = await provider.issue(processing, tenant, material);
      if (outcome.kind === 'ISSUED') {
        return this.onIssued(
          markIssued(processing, outcome.nfse, tenant.notifications, this.deps.clock.now())
        );
      }
      if (outcome.kind === 'DUPLICATE') {
        const found = await provider.findByDpsId(processing, tenant, material);
        if (found) {
          // Só adota se for mesmo a nota desta venda (mesmo valor e tomador); senão o número
          // do DPS já foi usado por outro sistema.
          if (!nfseMatchesInvoice(found, processing))
            return this.onNumberConflict(processing, found);
          return this.onIssued(
            markIssued(processing, found, tenant.notifications, this.deps.clock.now())
          );
        }
        return this.onTransient(processing, 'DPS duplicado ainda não disponível para consulta');
      }
      return this.persist(markRejected(processing, outcome.errors, this.deps.clock.now()));
    } catch (error) {
      const reason =
        error instanceof FiscalProviderUnavailableError
          ? error.message
          : `Erro inesperado: ${error instanceof Error ? error.message : String(error)}`;
      if (!(error instanceof FiscalProviderUnavailableError)) {
        this.deps.logger.error('Erro inesperado na emissão', { invoiceId, error: String(error) });
      }
      return this.onTransient(processing, reason);
    }
  }

  private onNumberConflict(processing: Invoice, foreign: IssuedNfse): Promise<Invoice> {
    this.deps.logger.warn('Número de DPS já usado por outro sistema', {
      invoiceId: processing.id,
      dpsId: processing.dps.id,
      existingNfse: foreign.number,
    });
    return this.persist(
      markRejected(
        processing,
        [
          {
            code: DPS_NUMBER_CONFLICT,
            message: `O número ${processing.dps.number} da série ${processing.dps.series} já foi usado em outra nota (NFS-e ${foreign.number}), provavelmente emitida por outro sistema.`,
            complement:
              'Ajuste a numeração (série exclusiva ou próximo número) e reprocesse: a nota receberá um novo número.',
          },
        ],
        this.deps.clock.now()
      )
    );
  }

  private async onTransient(processing: Invoice, reason: string): Promise<Invoice> {
    const failed = markTransientFailure(processing, reason, this.deps.clock.now());
    await this.persist(failed);
    if (failed.status === 'RETRYING' && failed.nextAttemptAt) {
      await this.deps.scheduler
        .scheduleIssue(failed.id, failed.nextAttemptAt)
        .catch(() => undefined);
    }
    return failed;
  }

  private async onIssued(issued: Invoice): Promise<Invoice> {
    await this.persist(issued);
    // Outbox da cobrança: a própria nota emitida; o job cobra e o reconciliador cobre falhas.
    await this.deps.scheduler.scheduleCharge(issued.id).catch(() => undefined);
    if (await this.refundRequested(issued)) {
      // Estornada enquanto emitia: cancela em seguida e não envia ao cliente.
      await this.deps.scheduler.scheduleRefund(issued.id).catch(() => undefined);
      return issued;
    }
    for (const delivery of issued.deliveries) {
      await this.deps.scheduler
        .scheduleDelivery(issued.id, delivery.channel)
        .catch(() => undefined);
    }
    return issued;
  }

  private async persist(invoice: Invoice): Promise<Invoice> {
    const ok = await this.deps.invoices.updateIfStatus(invoice, 'PROCESSING');
    if (!ok)
      this.deps.logger.warn('Nota alterada concorrentemente durante a emissão', {
        invoiceId: invoice.id,
      });
    return invoice;
  }

  // ---------- Ações do usuário ----------

  /** Prévia do que será enviado à prefeitura (modo piloto). */
  async preview(tenant: Tenant, id: string): Promise<{ provider: string; xml: string }> {
    const invoice = await this.get(tenant.id, id);
    const provider = this.deps.providers.resolve(tenant);
    if (!provider.preview) {
      throw DomainError.validation(`O provedor ${provider.name} não oferece prévia`);
    }
    return { provider: provider.name, xml: provider.preview(invoice, tenant) };
  }

  /** Modo piloto: o usuário conferiu a prévia e libera o envio desta nota à prefeitura. */
  async approve(tenant: Tenant, id: string, via: 'MCP' | 'API' | 'APP'): Promise<Invoice> {
    const invoice = await this.get(tenant.id, id);
    if (!['PENDING', 'RETRYING', 'REJECTED', 'FAILED'].includes(invoice.status)) {
      throw DomainError.invalidState(`A nota está ${invoice.status}; não há o que aprovar`);
    }
    const now = this.deps.clock.now();
    const base = ['REJECTED', 'FAILED'].includes(invoice.status) ? requeue(invoice, now) : invoice;
    const approved: Invoice = {
      ...base,
      approval: { at: now, via },
      lastErrors: base.lastErrors?.filter((e) => e.code !== AWAITING_APPROVAL),
      history: [...base.history, { at: now, event: 'APPROVED', message: `via ${via}` }].slice(-100),
      updatedAt: now,
    };
    if (!(await this.deps.invoices.updateIfStatus(approved, invoice.status))) {
      throw new DomainError('CONFLICT', 'A nota foi alterada por outro processo; tente novamente');
    }
    await this.deps.scheduler.scheduleIssue(approved.id);
    return approved;
  }

  /** Uma nota da prefeitura pelo número, com o XML como gravado (inclusive de outros sistemas). */
  async getMunicipal(tenant: Tenant, number: string, issuedOn?: Date) {
    const provider = this.deps.providers.resolve(tenant);
    if (!provider.getIssued) {
      throw DomainError.validation(`O provedor ${provider.name} não oferece esta consulta`);
    }
    // Nota emitida por nós: já sabemos o dia, então a consulta vai pelo período.
    const day =
      issuedOn ??
      (await this.deps.invoices.findByNfseNumber(tenant.id, number.trim()))?.nfse?.issuedAt;
    const material = await this.deps.certificates.loadMaterial(tenant);
    const nfse = await provider.getIssued(tenant, material, number.trim(), day);
    if (!nfse) throw DomainError.notFound('NFS-e na prefeitura', number);
    return nfse;
  }

  canListMunicipal(tenant: Tenant): boolean {
    return Boolean(this.deps.providers.resolve(tenant).listIssued);
  }

  /** Notas já emitidas no município (inclusive por outros sistemas), direto da prefeitura. */
  async listMunicipal(tenant: Tenant, range: { from: Date; to: Date }) {
    const provider = this.deps.providers.resolve(tenant);
    if (!provider.listIssued) {
      throw DomainError.validation(`O provedor ${provider.name} não oferece esta consulta`);
    }
    const material = await this.deps.certificates.loadMaterial(tenant);
    const notes = await provider.listIssued(tenant, material, range);
    // Notas que nós mesmos emitimos (para separar das emitidas por outro sistema, ex.: eNotas).
    const ours = new Set(
      (
        await this.deps.invoices.findIssuedBetween(
          tenant.id,
          new Date(range.from.getTime() - 86_400_000),
          new Date(range.to.getTime() + 86_400_000)
        )
      )
        .filter(
          (i) =>
            i.nfse?.provider === provider.name ||
            (!i.nfse?.provider && provider.name === 'NACIONAL')
        )
        .map((i) => i.nfse!.number)
    );
    return notes.map((n) => ({ ...n, issuedByAcainfe: ours.has(n.number) }));
  }

  async retry(tenantId: string, id: string): Promise<Invoice> {
    const invoice = await this.get(tenantId, id);
    let requeued = requeue(invoice, this.deps.clock.now());
    if (invoice.lastErrors?.some((e) => e.code === DPS_NUMBER_CONFLICT)) {
      // Número colidiu com outro sistema: reprocessa com um número novo na série atual.
      const tenant = await this.deps.tenants.findById(tenantId);
      if (!tenant) throw DomainError.notFound('Empresa', tenantId);
      const { first: number, series } = await this.deps.tenants.reserveDpsNumbers(tenantId, 1);
      requeued = renumber(
        requeued,
        { series, number, id: buildDpsId(tenant.cityCode, tenant.cnpj, series, number) },
        this.deps.clock.now()
      );
    }
    if (!(await this.deps.invoices.updateIfStatus(requeued, invoice.status))) {
      throw new DomainError('CONFLICT', 'A nota foi alterada por outro processo; tente novamente');
    }
    await this.deps.scheduler.scheduleIssue(requeued.id);
    return requeued;
  }

  async cancel(
    tenant: Tenant,
    id: string,
    reasonCode: string,
    description: string
  ): Promise<Invoice> {
    if (!CANCELLATION_REASONS[reasonCode]) {
      throw DomainError.validation(
        'reasonCode deve ser 1 (erro na emissão), 2 (serviço não prestado) ou 9 (outros)'
      );
    }
    if (!description || description.trim().length < 15) {
      throw DomainError.validation(
        'A justificativa do cancelamento deve ter ao menos 15 caracteres'
      );
    }
    const invoice = await this.get(tenant.id, id);
    if (invoice.status !== 'ISSUED') {
      throw DomainError.invalidState(
        `Só é possível cancelar notas emitidas (status atual: ${invoice.status})`
      );
    }
    const material = await this.deps.certificates.loadMaterial(tenant);
    const result = await this.deps.providers
      .resolve(tenant)
      .cancel(invoice, tenant, material, { code: reasonCode, description: description.trim() });
    if (!result.ok) {
      throw new DomainError('VALIDATION', 'A prefeitura recusou o cancelamento', {
        errors: result.errors,
        hints: explainFiscalErrors(result.errors),
      });
    }
    const cancelled = markCancelled(invoice, reasonCode, description.trim(), this.deps.clock.now());
    if (!(await this.deps.invoices.updateIfStatus(cancelled, 'ISSUED'))) {
      this.deps.logger.warn('Nota alterada durante o cancelamento', { invoiceId: id });
    }
    return cancelled;
  }

  async resend(
    tenantId: string,
    id: string,
    channel: DeliveryChannel,
    to?: string
  ): Promise<Invoice> {
    const invoice = await this.get(tenantId, id);
    const destination =
      to ?? (channel === 'EMAIL' ? invoice.customer.email : invoice.customer.phone);
    if (!destination)
      throw DomainError.validation(
        `Tomador sem ${channel === 'EMAIL' ? 'e-mail' : 'WhatsApp'} cadastrado`
      );
    const prepared = prepareDelivery(invoice, channel, destination, this.deps.clock.now());
    await this.deps.invoices.saveDelivery(prepared, channel);
    await this.deps.scheduler.scheduleDelivery(prepared.id, channel);
    return prepared;
  }

  // ---------- Entrega (job) ----------

  /** Handler do job `deliver-invoice`: envia o DANFSe por e-mail ou WhatsApp. */
  async deliver(invoiceId: string, channel: DeliveryChannel): Promise<void> {
    const invoice = await this.deps.invoices.findByIdInternal(invoiceId);
    if (!invoice?.nfse) return;
    const delivery = invoice.deliveries.find((d) => d.channel === channel);
    if (!delivery || delivery.status === 'SENT' || delivery.attempts >= MAX_DELIVERY_ATTEMPTS)
      return;
    const tenant = await this.deps.tenants.findById(invoice.tenantId);
    if (!tenant || (await this.refundRequested(invoice))) return;

    const now = () => this.deps.clock.now();
    try {
      const pdf = await this.render(invoice, tenant);
      const fileName = `NFSe-${invoice.nfse.number}.pdf`;
      const issuer = tenant.tradeName ?? tenant.legalName;
      const summary = `NFS-e nº ${invoice.nfse.number} de ${issuer} no valor de ${formatBRL(invoice.amountCents)}.`;
      if (channel === 'EMAIL') {
        await this.deps.email.send({
          to: delivery.to,
          subject: `Sua nota fiscal de serviço nº ${invoice.nfse.number} — ${issuer}`,
          text: `${summary}\nConsulte a autenticidade em: ${invoice.nfse.verificationUrl}`,
          html: `<p>Olá${invoice.customer.name ? `, ${escapeHtml(invoice.customer.name)}` : ''}!</p><p>${escapeHtml(summary)}</p><p>O PDF (DANFSe) segue em anexo. Consulte a autenticidade em <a href="${invoice.nfse.verificationUrl}">${invoice.nfse.verificationUrl}</a>.</p>`,
          attachments: [{ filename: fileName, content: pdf, contentType: 'application/pdf' }],
        });
      } else {
        await this.deps.whatsapp.sendDocument({
          phone: delivery.to,
          caption: `${summary}\nAutenticidade: ${invoice.nfse.verificationUrl}`,
          fileName,
          file: pdf,
          fileUrl: this.deps.links.pdfUrl(invoice.id),
        });
      }
      await this.deps.invoices.saveDelivery(
        recordDelivery(invoice, channel, { ok: true }, now()),
        channel
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = recordDelivery(invoice, channel, { ok: false, error: message }, now());
      await this.deps.invoices.saveDelivery(updated, channel);
      const attempts = updated.deliveries.find((d) => d.channel === channel)!.attempts;
      if (attempts < MAX_DELIVERY_ATTEMPTS) {
        await this.deps.scheduler
          .scheduleDelivery(invoice.id, channel, new Date(now().getTime() + attempts * 5 * 60_000))
          .catch(() => undefined);
      }
      this.deps.logger.warn('Falha ao entregar nota', { invoiceId, channel, error: message });
    }
  }

  // ---------- Reconciliação (job recorrente) ----------

  /** Rede de segurança: reagenda notas pendentes/vencidas e recupera notas travadas em PROCESSING. */
  async reconcile(limit = 200): Promise<{ rescheduled: number; recovered: number }> {
    const now = this.deps.clock.now();
    let recovered = 0;
    for (const stuck of await this.deps.invoices.findStuckProcessing(
      new Date(now.getTime() - STUCK_AFTER_MS),
      limit
    )) {
      if (await this.deps.invoices.updateIfStatus(recoverStuck(stuck, now), 'PROCESSING'))
        recovered++;
    }
    const due = await this.deps.invoices.findDue(now, limit);
    for (const invoice of due)
      await this.deps.scheduler.scheduleIssue(invoice.id).catch(() => undefined);
    for (const invoice of await this.deps.invoices.findPendingDeliveries(
      new Date(now.getTime() - STUCK_AFTER_MS),
      limit
    )) {
      for (const d of invoice.deliveries.filter((x) => x.status === 'PENDING')) {
        await this.deps.scheduler.scheduleDelivery(invoice.id, d.channel).catch(() => undefined);
      }
    }
    return { rescheduled: due.length, recovered };
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
