import {
  applyPayment,
  BillingAccount,
  BillingCharge,
  BillingPayment,
  BillingSummary,
  newAccount,
  summarize,
} from '../../domain/billing/billing.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { formatBRL } from '../../domain/shared/money.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import {
  BillingRepository,
  InvoiceRepository,
  Page,
  Pagination,
  TenantRepository,
  UserRepository,
} from '../ports/repositories.js';
import {
  BillingPaymentGateway,
  Clock,
  EmailSender,
  IdGenerator,
  JobScheduler,
  Logger,
  WhatsappSender,
} from '../ports/services.js';

export interface BillingConfig {
  /** Preço padrão por nota (hoje R$ 0,80 — oferta de lançamento). */
  pricePerInvoiceCents: number;
  /** Dias para pagar antes de pausar a emissão. */
  graceDays: number;
  /** Validade do Pix gerado. */
  pixExpiresInSeconds: number;
}

export const BILLING_BLOCKED_CODE = 'BILLING_BLOCKED';

export const LEGAL_WARNING =
  'Atenção: a emissão de nota fiscal de serviço é obrigatória. Enquanto a emissão estiver pausada, suas vendas continuam ' +
  'registradas, mas as notas não são emitidas, e você pode ficar em desacordo com a legislação fiscal e sujeito a ' +
  'penalidades do município. Assim que o pagamento for confirmado, as notas pendentes são emitidas automaticamente.';

const isSameDay = (a: Date, b: Date): boolean =>
  a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
const br = (d: Date): string => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Cobrança interna: cada NFS-e emitida gera uma cobrança. Saldo avisado diariamente (e-mail/WhatsApp com Pix);
 * cobrança em aberto além do prazo pausa a emissão (as vendas continuam sendo registradas).
 */
export class BillingService {
  constructor(
    private readonly deps: {
      billing: BillingRepository;
      invoices: InvoiceRepository;
      tenants: TenantRepository;
      users: UserRepository;
      scheduler: JobScheduler;
      gateway?: BillingPaymentGateway;
      email: EmailSender;
      whatsapp: WhatsappSender;
      clock: Clock;
      ids: IdGenerator;
      logger: Logger;
      config: BillingConfig;
    }
  ) {}

  private now(): Date {
    return this.deps.clock.now();
  }

  async account(tenantId: string): Promise<BillingAccount> {
    return (await this.deps.billing.getAccount(tenantId)) ?? newAccount(tenantId, this.now());
  }

  /** Handler do job `charge-invoice`. Idempotente: uma cobrança por nota emitida. */
  async charge(invoiceId: string): Promise<BillingCharge | null> {
    const invoice = await this.deps.invoices.findByIdInternal(invoiceId);
    if (!invoice?.nfse) return null; // só NFS-e emitida com sucesso é cobrada
    if (invoice.environment === 'HOMOLOGATION') return null; // nota de teste, sem valor fiscal
    const existing = await this.deps.billing.findChargeByInvoice(invoiceId);
    if (existing) {
      if (!invoice.billedChargeId) await this.deps.invoices.markBilled(invoiceId, existing.id);
      return existing;
    }
    const account = await this.account(invoice.tenantId);
    const amount = account.pricePerInvoiceCents ?? this.deps.config.pricePerInvoiceCents;
    const now = this.now();
    let charge: BillingCharge = {
      id: this.deps.ids.next(),
      tenantId: invoice.tenantId,
      invoiceId,
      nfseNumber: invoice.nfse.number,
      amountCents: amount,
      status: 'OPEN',
      createdAt: now,
    };
    // Crédito disponível (sobra de Pix anterior) quita a cobrança na hora.
    if (account.creditCents >= amount) {
      charge = { ...charge, status: 'PAID', paidAt: now, settledBy: 'CREDIT' };
    }
    if (!(await this.deps.billing.createCharge(charge))) {
      return this.deps.billing.findChargeByInvoice(invoiceId);
    }
    if (charge.status === 'PAID') {
      await this.deps.billing.saveAccount({
        ...account,
        creditCents: account.creditCents - amount,
        updatedAt: now,
      });
    }
    await this.deps.invoices.markBilled(invoiceId, charge.id);
    return charge;
  }

  /** Varredura do outbox: cobra notas emitidas que ficaram sem cobrança (ex.: falha ao enfileirar). */
  async sweepUnbilled(limit = 200): Promise<number> {
    let charged = 0;
    for (const invoice of await this.deps.invoices.findUnbilled(limit)) {
      if (await this.charge(invoice.id)) charged++;
    }
    return charged;
  }

  async summary(tenantId: string): Promise<BillingSummary> {
    const [account, open] = await Promise.all([
      this.account(tenantId),
      this.deps.billing.findOpenCharges(tenantId),
    ]);
    return summarize(
      account,
      open,
      this.now(),
      this.deps.config.graceDays,
      this.deps.config.pricePerInvoiceCents
    );
  }

  listCharges(tenantId: string, pagination: Pagination): Promise<Page<BillingCharge>> {
    return this.deps.billing.listCharges(tenantId, pagination);
  }

  listAccounts(status?: BillingAccount['status']): Promise<BillingAccount[]> {
    return this.deps.billing.listAccounts(status);
  }

  /** Preço negociado por nota (null = preço padrão). Vale para as próximas cobranças. */
  async setPrice(tenantId: string, pricePerInvoiceCents: number | null): Promise<BillingSummary> {
    if (
      pricePerInvoiceCents !== null &&
      (!Number.isInteger(pricePerInvoiceCents) || pricePerInvoiceCents < 0)
    ) {
      throw DomainError.validation('pricePerInvoiceCents inválido');
    }
    if (!(await this.deps.tenants.findById(tenantId)))
      throw DomainError.notFound('Empresa', tenantId);
    const account = await this.account(tenantId);
    await this.deps.billing.saveAccount({
      ...account,
      pricePerInvoiceCents: pricePerInvoiceCents ?? undefined,
      updatedAt: this.now(),
    });
    return this.summary(tenantId);
  }

  /** Emissão pausada por inadimplência? Consultado antes de cada emissão. */
  async isBlocked(tenantId: string): Promise<boolean> {
    return (await this.deps.billing.getAccount(tenantId))?.status === 'BLOCKED';
  }

  /** Gera (ou reaproveita) o Pix do saldo em aberto. */
  async createPayment(tenant: Tenant): Promise<BillingPayment> {
    const summary = await this.summary(tenant.id);
    if (summary.amountDueCents === 0) throw DomainError.invalidState('Não há saldo em aberto');
    const now = this.now();
    const pending = await this.deps.billing.findPendingPayment(tenant.id, now);
    if (pending && pending.amountCents === summary.amountDueCents) return pending;
    if (!this.deps.gateway)
      throw DomainError.invalidState(
        'Pagamento via Pix indisponível no momento; fale com o suporte'
      );

    const open = await this.deps.billing.findOpenCharges(tenant.id);
    const id = this.deps.ids.next();
    // Celular do pagador: o da empresa ou o WhatsApp de um dono. Sem nenhum, o Pix sai sem pagador.
    const owners = await this.deps.users.findByTenant(tenant.id);
    const phone = [tenant.phone, ...owners.map((u) => u.whatsapp)].find(Boolean);
    const pix = await this.deps.gateway.createPix({
      amountCents: summary.amountDueCents,
      description: `açaínfe: ${open.length} nota(s) fiscal(is) emitida(s)`,
      expiresInSeconds: this.deps.config.pixExpiresInSeconds,
      customer: phone
        ? {
            name: tenant.legalName,
            email: tenant.email,
            taxId: tenant.cnpj,
            cellphone: formatCellphone(phone),
          }
        : undefined,
      metadata: { tenantId: tenant.id, paymentId: id },
    });
    if (pending) await this.deps.billing.updatePayment({ ...pending, status: 'EXPIRED' });
    const payment: BillingPayment = {
      id,
      tenantId: tenant.id,
      amountCents: summary.amountDueCents,
      chargeIds: open.map((c) => c.id),
      status: 'PENDING',
      provider: 'ABACATEPAY',
      providerId: pix.providerId,
      pixCopyPaste: pix.copyPaste,
      pixQrCodeImage: pix.qrCodeImage,
      expiresAt:
        pix.expiresAt ?? new Date(now.getTime() + this.deps.config.pixExpiresInSeconds * 1000),
      createdAt: now,
    };
    await this.deps.billing.createPayment(payment);
    return payment;
  }

  /** Webhook do gateway: Pix pago. Idempotente. */
  async confirmPayment(providerId: string, paidCents?: number): Promise<BillingPayment | null> {
    const payment = await this.deps.billing.findPaymentByProviderId(providerId);
    if (!payment) return null;
    if (payment.status === 'PAID') return payment;
    const paid: BillingPayment = {
      ...payment,
      status: 'PAID',
      paidAt: this.now(),
      paidAmountCents: paidCents ?? payment.amountCents,
    };
    await this.deps.billing.updatePayment(paid);
    await this.settle(payment.tenantId, paid.paidAmountCents!, payment.id);
    return paid;
  }

  /** Pagamento registrado manualmente (admin), ex.: transferência fora do Pix gerado. */
  async recordManualPayment(tenantId: string, amountCents: number): Promise<BillingSummary> {
    if (!Number.isInteger(amountCents) || amountCents <= 0)
      throw DomainError.validation('amountCents inválido');
    const payment: BillingPayment = {
      id: this.deps.ids.next(),
      tenantId,
      amountCents,
      chargeIds: [],
      status: 'PAID',
      provider: 'MANUAL',
      createdAt: this.now(),
      paidAt: this.now(),
      paidAmountCents: amountCents,
    };
    await this.deps.billing.createPayment(payment);
    await this.settle(tenantId, amountCents, payment.id);
    return this.summary(tenantId);
  }

  /** Quita cobranças em aberto (mais antigas primeiro), guarda a sobra e reavalia a pausa. */
  private async settle(tenantId: string, paidCents: number, paymentId: string): Promise<void> {
    const account = await this.account(tenantId);
    const open = await this.deps.billing.findOpenCharges(tenantId);
    const { settled, creditCents } = applyPayment(open, paidCents, account.creditCents);
    await this.deps.billing.markChargesPaid(
      settled.map((c) => c.id),
      this.now(),
      paymentId
    );
    await this.deps.billing.saveAccount({ ...account, creditCents, updatedAt: this.now() });
    const tenant = await this.deps.tenants.findById(tenantId);
    if (tenant) {
      await this.notify(
        tenant,
        'Pagamento recebido — obrigado!',
        `Recebemos ${formatBRL(paidCents)} referente às notas emitidas pelo açaínfe para ${tenant.legalName}.`
      );
    }
    await this.evaluate(tenantId);
  }

  /** Pausa ou retoma a emissão conforme o saldo vencido. */
  async evaluate(tenantId: string): Promise<BillingSummary> {
    const account = await this.account(tenantId);
    const summary = await this.summary(tenantId);
    const tenant = await this.deps.tenants.findById(tenantId);
    if (summary.overdue && account.status === 'OK') {
      await this.deps.billing.saveAccount({
        ...account,
        status: 'BLOCKED',
        blockedAt: this.now(),
        updatedAt: this.now(),
      });
      this.deps.logger.warn('Emissão pausada por saldo vencido', {
        tenantId,
        openCents: summary.openCents,
      });
      if (tenant) await this.notifyBlocked(tenant, summary);
    } else if (!summary.overdue && account.status === 'BLOCKED') {
      await this.deps.billing.saveAccount({
        ...account,
        status: 'OK',
        blockedAt: undefined,
        updatedAt: this.now(),
      });
      await this.resumeEmission(tenantId);
      if (tenant) {
        await this.notify(
          tenant,
          'Emissão de notas retomada',
          `A emissão de notas de ${tenant.legalName} foi retomada. As notas pendentes já estão sendo emitidas.`
        );
      }
    }
    return this.summary(tenantId);
  }

  private async resumeEmission(tenantId: string): Promise<void> {
    for (const invoice of await this.deps.invoices.findByTenantAndStatus(
      tenantId,
      ['PENDING', 'RETRYING'],
      1000
    )) {
      await this.deps.scheduler.scheduleIssue(invoice.id).catch(() => undefined);
    }
  }

  /** Job diário (9h): avisa o saldo em aberto com o Pix e aplica/remove a pausa. */
  async daily(): Promise<{ reviewed: number; reminded: number; blocked: number }> {
    let reminded = 0;
    let blocked = 0;
    const tenantIds = await this.deps.billing.tenantsToReview();
    for (const tenantId of tenantIds) {
      try {
        const before = await this.account(tenantId);
        const summary = await this.evaluate(tenantId);
        if (summary.status === 'BLOCKED' && before.status === 'OK') blocked++;
        const account = await this.account(tenantId);
        if (
          summary.openCents === 0 ||
          (account.lastReminderAt && isSameDay(account.lastReminderAt, this.now()))
        )
          continue;
        const tenant = await this.deps.tenants.findById(tenantId);
        if (!tenant) continue;
        await this.remind(tenant, summary);
        await this.deps.billing.saveAccount({
          ...account,
          lastReminderAt: this.now(),
          updatedAt: this.now(),
        });
        reminded++;
      } catch (error) {
        this.deps.logger.error('Falha no ciclo diário de cobrança', {
          tenantId,
          error: String(error),
        });
      }
    }
    return { reviewed: tenantIds.length, reminded, blocked };
  }

  private async pixText(tenant: Tenant, summary: BillingSummary): Promise<string> {
    if (summary.amountDueCents === 0) return '';
    try {
      const payment = await this.createPayment(tenant);
      return `\n\nPague com Pix (copia e cola):\n${payment.pixCopyPaste}`;
    } catch (error) {
      this.deps.logger.warn('Não foi possível gerar o Pix do aviso', {
        tenantId: tenant.id,
        error: String(error),
      });
      return '';
    }
  }

  private async remind(tenant: Tenant, summary: BillingSummary): Promise<void> {
    const pix = await this.pixText(tenant, summary);
    const deadline =
      summary.status === 'BLOCKED'
        ? `A emissão está PAUSADA. ${LEGAL_WARNING}`
        : summary.blocksAt
          ? `Pague até ${br(summary.blocksAt)} para não pausar a emissão das suas notas.`
          : '';
    await this.notify(
      tenant,
      summary.status === 'BLOCKED'
        ? 'Emissão pausada — regularize seu saldo'
        : `Saldo açaínfe: ${formatBRL(summary.amountDueCents)}`,
      `${tenant.legalName}: você tem ${summary.openCharges} nota(s) emitida(s) em aberto, total de ${formatBRL(summary.openCents)}` +
        `${summary.creditCents ? ` (crédito de ${formatBRL(summary.creditCents)})` : ''}. ` +
        `Valor a pagar: ${formatBRL(summary.amountDueCents)}. ${deadline}${pix}`
    );
  }

  private async notifyBlocked(tenant: Tenant, summary: BillingSummary): Promise<void> {
    const pix = await this.pixText(tenant, summary);
    await this.notify(
      tenant,
      'Emissão de notas pausada por saldo em aberto',
      `A emissão de notas de ${tenant.legalName} foi pausada porque há ${formatBRL(summary.openCents)} em aberto há mais de ` +
        `${this.deps.config.graceDays} dias. ${LEGAL_WARNING}${pix}`
    );
  }

  /** Envia para o e-mail/WhatsApp da empresa e dos administradores. */
  private async notify(tenant: Tenant, subject: string, text: string): Promise<void> {
    const users = await this.deps.users.findByTenant(tenant.id);
    const emails = new Set([tenant.email, ...users.map((u) => u.email)].filter(Boolean));
    const phones = new Set(
      [tenant.phone, ...users.map((u) => u.whatsapp)].filter((p): p is string => Boolean(p))
    );
    const html = `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`;
    for (const to of emails) {
      await this.deps.email
        .send({ to, subject, text, html, attachments: [] })
        .catch((e: unknown) =>
          this.deps.logger.warn('Falha ao enviar aviso de cobrança', { to, error: String(e) })
        );
    }
    for (const phone of phones) {
      await this.deps.whatsapp.sendText(phone, `*${subject}*\n${text}`).catch((e: unknown) =>
        this.deps.logger.warn('Falha ao enviar aviso de cobrança (WhatsApp)', {
          error: String(e),
        })
      );
    }
  }
}

/** 5511999998888 → "(11) 99999-8888" (formato dos exemplos da AbacatePay). */
export function formatCellphone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const m = /^(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}
