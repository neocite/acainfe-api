import { Agenda } from 'agenda';
import { MongoBackend } from '@agendajs/mongo-backend';
import { Db } from 'mongodb';
import { JobScheduler } from '../../../application/ports/services.js';

export const JOBS = {
  issueInvoice: 'issue-invoice',
  deliverInvoice: 'deliver-invoice',
  refundInvoice: 'refund-invoice',
  chargeInvoice: 'charge-invoice',
  billingDaily: 'billing-daily',
  billingInvoices: 'billing-monthly-invoices',
  activationReminders: 'activation-reminders',
  activationDigest: 'activation-digest',
  accountantMonthly: 'accountant-monthly',
  reconcile: 'reconcile-invoices',
  certificateExpiry: 'certificate-expiry-warning',
} as const;

export interface IssueJobData {
  invoiceId: string;
}
export interface DeliveryJobData {
  invoiceId: string;
  channel: 'EMAIL' | 'WHATSAPP';
}

export function createAgenda(
  db: Db,
  options: { processEvery?: string | number; name?: string } = {}
): Agenda {
  return new Agenda({
    name: options.name ?? 'acainfe',
    backend: new MongoBackend({ mongo: db, collection: 'jobs' }),
    processEvery:
      typeof options.processEvery === 'string' && /^\d+$/.test(options.processEvery)
        ? Number(options.processEvery)
        : (options.processEvery ?? '5 seconds'),
    defaultConcurrency: 5,
    maxConcurrency: 20,
  });
}

/**
 * Fila persistida no próprio MongoDB (sem Redis). Jobs são únicos por nota/canal:
 * reagendar a mesma nota apenas move o horário do job existente, nunca duplica.
 */
export class AgendaJobScheduler implements JobScheduler {
  constructor(private readonly agenda: Agenda) {}

  async scheduleIssue(invoiceId: string, at?: Date): Promise<void> {
    await this.agenda
      .create<IssueJobData>(JOBS.issueInvoice, { invoiceId })
      .unique({ 'data.invoiceId': invoiceId })
      .schedule(at ?? new Date())
      .save();
  }

  async scheduleDelivery(
    invoiceId: string,
    channel: 'EMAIL' | 'WHATSAPP',
    at?: Date
  ): Promise<void> {
    await this.agenda
      .create<DeliveryJobData>(JOBS.deliverInvoice, { invoiceId, channel })
      .unique({ 'data.invoiceId': invoiceId, 'data.channel': channel })
      .schedule(at ?? new Date())
      .save();
  }

  async scheduleRefund(invoiceId: string, at?: Date): Promise<void> {
    await this.agenda
      .create<IssueJobData>(JOBS.refundInvoice, { invoiceId })
      .unique({ 'data.invoiceId': invoiceId })
      .schedule(at ?? new Date())
      .save();
  }

  async scheduleCharge(invoiceId: string, at?: Date): Promise<void> {
    await this.agenda
      .create<IssueJobData>(JOBS.chargeInvoice, { invoiceId })
      .unique({ 'data.invoiceId': invoiceId })
      .schedule(at ?? new Date())
      .save();
  }
}
