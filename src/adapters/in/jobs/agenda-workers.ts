import { Agenda } from 'agenda';
import { Logger } from '../../../application/ports/services.js';
import { AccountantService } from '../../../application/use-cases/accountant.service.js';
import { BillingService } from '../../../application/use-cases/billing.service.js';
import { CertificateService } from '../../../application/use-cases/certificate.service.js';
import { InvoiceService } from '../../../application/use-cases/invoice.service.js';
import { RefundService } from '../../../application/use-cases/refund.service.js';
import { SaleService } from '../../../application/use-cases/sale.service.js';
import { DeliveryJobData, IssueJobData, JOBS } from '../../out/scheduler/agenda-scheduler.js';

/** Adaptador de entrada: liga os jobs da fila aos casos de uso. */
export async function registerWorkers(
  agenda: Agenda,
  services: {
    invoices: InvoiceService;
    refunds: RefundService;
    sales: SaleService;
    billing: BillingService;
    accountant: AccountantService;
    certificates: CertificateService;
    logger: Logger;
  },
  options: { recurring: boolean } = { recurring: true }
): Promise<void> {
  agenda.define<IssueJobData>(
    JOBS.issueInvoice,
    async (job) => {
      await services.invoices.issue(job.attrs.data.invoiceId);
    },
    { concurrency: 5, lockLifetime: 5 * 60_000 }
  );

  agenda.define<DeliveryJobData>(
    JOBS.deliverInvoice,
    async (job) => {
      await services.invoices.deliver(job.attrs.data.invoiceId, job.attrs.data.channel);
    },
    { concurrency: 5 }
  );

  agenda.define<IssueJobData>(
    JOBS.refundInvoice,
    async (job) => {
      await services.refunds.settle(job.attrs.data.invoiceId);
    },
    { concurrency: 3 }
  );

  agenda.define<IssueJobData>(
    JOBS.chargeInvoice,
    async (job) => {
      await services.billing.charge(job.attrs.data.invoiceId);
    },
    { concurrency: 5 }
  );

  agenda.define(JOBS.accountantMonthly, async () => {
    const result = await services.accountant.runMonthly();
    if (result.sent || result.failed) services.logger.info('Envio mensal ao contador', result);
  });

  agenda.define(JOBS.billingDaily, async () => {
    const result = await services.billing.daily();
    services.logger.info('Ciclo diário de cobrança', result);
  });

  agenda.define(JOBS.reconcile, async () => {
    const charged = await services.billing.sweepUnbilled();
    if (charged) services.logger.info('Cobranças geradas pela varredura', { charged });
    const released = await services.sales.resumeHeld();
    if (released) services.logger.info('Vendas retidas liberadas', { released });
    const result = await services.invoices.reconcile();
    if (result.recovered || result.rescheduled)
      services.logger.info('Reconciliação de notas', result);
  });

  agenda.define(JOBS.certificateExpiry, async () => {
    const sent = await services.certificates.warnExpiring();
    if (sent) services.logger.info('Avisos de vencimento de certificado enviados', { sent });
  });

  if (options.recurring) {
    await agenda.every('2 minutes', JOBS.reconcile);
    await agenda.every('0 9 * * *', JOBS.certificateExpiry, undefined, {
      timezone: 'America/Sao_Paulo',
    });
    await agenda.every('0 9 * * *', JOBS.billingDaily, undefined, {
      timezone: 'America/Sao_Paulo',
    });
    await agenda.every('0 8 * * *', JOBS.accountantMonthly, undefined, {
      timezone: 'America/Sao_Paulo',
    });
  }
}
