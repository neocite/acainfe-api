import {
  AccountantReport,
  brtDayOfMonth,
  periodRange,
  previousPeriod,
} from '../../domain/accounting/accountant-report.js';
import { Invoice } from '../../domain/invoice/invoice.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { formatBRL } from '../../domain/shared/money.js';
import { createAccountant, Tenant } from '../../domain/tenant/tenant.js';
import {
  AccountantReportRepository,
  InvoiceRepository,
  LogoRepository,
  SaleRepository,
  TenantRepository,
} from '../ports/repositories.js';
import {
  ArchiveBuilder,
  Clock,
  DanfseRenderer,
  DocumentLinks,
  EmailSender,
  IdGenerator,
  Logger,
  WhatsappSender,
} from '../ports/services.js';
import { buildAccountantCsv } from './accountant-csv.js';

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
/** Acima disso o ZIP não vai anexo no e-mail (só o link). */
const MAX_EMAIL_ZIP_BYTES = 10 * 1024 * 1024;

const monthLabel = (period: string): string =>
  `${MONTHS[Number(period.slice(5, 7)) - 1]}/${period.slice(0, 4)}`;

export interface AccountantPackage {
  period: string;
  invoices: Invoice[];
  totalCents: number;
  csv: Buffer;
  zip: Buffer;
  zipName: string;
  csvName: string;
}

/**
 * Fechamento mensal para o contador: PDFs (DANFSe), XMLs e planilha (layout eNotas) das notas do mês,
 * enviados automaticamente por e-mail e WhatsApp.
 */
export class AccountantService {
  constructor(
    private readonly deps: {
      tenants: TenantRepository;
      invoices: InvoiceRepository;
      sales: SaleRepository;
      reports: AccountantReportRepository;
      logos: LogoRepository;
      renderer: DanfseRenderer;
      archive: ArchiveBuilder;
      links: DocumentLinks;
      email: EmailSender;
      whatsapp: WhatsappSender;
      clock: Clock;
      ids: IdGenerator;
      logger: Logger;
    }
  ) {}

  async setAccountant(
    tenantId: string,
    input: {
      name?: string;
      email?: string;
      whatsapp?: string;
      monthlyReport?: boolean;
      dayOfMonth?: number;
    } | null
  ): Promise<Tenant['accountant']> {
    const tenant = await this.deps.tenants.findById(tenantId);
    if (!tenant) throw DomainError.notFound('Empresa', tenantId);
    const accountant = input ? createAccountant(input) : undefined;
    await this.deps.tenants.update({ ...tenant, accountant, updatedAt: this.deps.clock.now() });
    return accountant;
  }

  /** Monta o pacote do mês (AAAA-MM): ZIP com PDFs + XMLs + planilha. */
  async buildPackage(tenant: Tenant, period: string): Promise<AccountantPackage> {
    const { from, to } = periodRange(period);
    // Notas de homologação não têm valor fiscal: não vão para o contador.
    const invoices = (await this.deps.invoices.findIssuedBetween(tenant.id, from, to)).filter(
      (i) => i.nfse && i.environment !== 'HOMOLOGATION'
    );
    const sales = await this.deps.sales.findManyByIds(tenant.id, [
      ...new Set(invoices.map((i) => i.saleId)),
    ]);
    const externalIds = new Map(sales.map((s) => [s.id, s.externalId]));
    const csvName = `notas-${period}.csv`;
    const csv = buildAccountantCsv(
      invoices.map((invoice) => ({ invoice, saleExternalId: externalIds.get(invoice.saleId) }))
    );
    const logo = (await this.deps.logos.find(tenant.id)) ?? undefined;
    const files: { name: string; content: Buffer }[] = [{ name: csvName, content: csv }];
    for (const invoice of invoices) {
      const base = `NFSe-${invoice.nfse!.number}${invoice.status === 'CANCELLED' ? '-CANCELADA' : ''}`;
      files.push({ name: `xml/${base}.xml`, content: Buffer.from(invoice.nfse!.xml, 'utf8') });
      files.push({
        name: `pdf/${base}.pdf`,
        content: await this.deps.renderer.render(invoice, tenant, { logo }),
      });
    }
    return {
      period,
      invoices,
      totalCents: invoices
        .filter((i) => i.status !== 'CANCELLED')
        .reduce((s, i) => s + i.amountCents, 0),
      csv,
      csvName,
      zip: this.deps.archive.zip(files),
      zipName: `acainfe-notas-${tenant.cnpj}-${period}.zip`,
    };
  }

  /** Envia o pacote do mês ao contador (e-mail com planilha + ZIP/link; WhatsApp com o ZIP). */
  async send(
    tenant: Tenant,
    period: string,
    trigger: AccountantReport['trigger']
  ): Promise<AccountantReport> {
    const accountant = tenant.accountant;
    if (!accountant?.email && !accountant?.whatsapp) {
      throw DomainError.validation('Cadastre o e-mail ou WhatsApp do contador antes de enviar');
    }
    const pkg = await this.buildPackage(tenant, period);
    const link = this.deps.links.accountantPackageUrl(tenant.id, period);
    const cancelled = pkg.invoices.filter((i) => i.status === 'CANCELLED').length;
    const company = `${tenant.legalName} (CNPJ ${tenant.cnpj})`;
    const summary =
      `Notas fiscais de serviço de ${monthLabel(period)} — ${company}: ${pkg.invoices.length} nota(s)` +
      `${cancelled ? `, ${cancelled} cancelada(s)` : ''}, total autorizado ${formatBRL(pkg.totalCents)}.`;
    const channels: AccountantReport['channels'] = [];
    const errors: string[] = [];

    if (accountant.email) {
      try {
        const attachZip = pkg.zip.length <= MAX_EMAIL_ZIP_BYTES;
        await this.deps.email.send({
          to: accountant.email,
          subject: `Notas fiscais de ${monthLabel(period)} — ${tenant.legalName}`,
          text:
            `Olá${accountant.name ? `, ${accountant.name}` : ''}!\n\n${summary}\n\n` +
            `Seguem a planilha (mesmo layout do eNotas)${attachZip ? ' e o ZIP com todos os PDFs e XMLs' : ''}.` +
            `${link ? `\nBaixar o pacote completo: ${link}` : ''}\n\nEnvio automático do açaínfe a pedido do seu cliente.`,
          html:
            `<p>Olá${accountant.name ? `, ${escapeHtml(accountant.name)}` : ''}!</p><p>${escapeHtml(summary)}</p>` +
            `<p>Seguem a planilha (mesmo layout do eNotas)${attachZip ? ' e o ZIP com todos os PDFs e XMLs' : ''}.</p>` +
            `${link ? `<p><a href="${link}">Baixar o pacote completo (PDFs + XMLs + planilha)</a></p>` : ''}` +
            `<p style="color:#777">Envio automático do açaínfe a pedido do seu cliente.</p>`,
          attachments: [
            { filename: pkg.csvName, content: pkg.csv, contentType: 'text/csv' },
            ...(attachZip
              ? [{ filename: pkg.zipName, content: pkg.zip, contentType: 'application/zip' }]
              : []),
          ],
        });
        channels.push('EMAIL');
      } catch (error) {
        errors.push(`e-mail: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (accountant.whatsapp) {
      try {
        await this.deps.whatsapp.sendDocument({
          phone: accountant.whatsapp,
          caption: `${summary}\nPDFs, XMLs e planilha no arquivo. Envio automático do açaínfe.`,
          fileName: pkg.zipName,
          file: pkg.zip,
          fileUrl: link,
        });
        channels.push('WHATSAPP');
      } catch (error) {
        errors.push(`WhatsApp: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const report: AccountantReport = {
      id: this.deps.ids.next(),
      tenantId: tenant.id,
      period,
      status: channels.length ? 'SENT' : 'FAILED',
      invoiceCount: pkg.invoices.length,
      totalCents: pkg.totalCents,
      channels,
      trigger,
      error: errors.length ? errors.join(' | ') : undefined,
      sentAt: this.deps.clock.now(),
    };
    await this.deps.reports.save(report);
    if (channels.length) await this.notifyCompany(tenant, period, report);
    return report;
  }

  /** Job diário: no dia configurado, envia o mês anterior a quem ainda não recebeu. */
  async runMonthly(): Promise<{ sent: number; failed: number }> {
    const now = this.deps.clock.now();
    const period = previousPeriod(now);
    let sent = 0;
    let failed = 0;
    for (const tenant of await this.deps.tenants.findWithAccountantReport()) {
      if (brtDayOfMonth(now) < (tenant.accountant?.dayOfMonth ?? 1)) continue;
      const existing = await this.deps.reports.findByPeriod(tenant.id, period);
      if (existing?.status === 'SENT') continue;
      try {
        const report = await this.send(tenant, period, 'SCHEDULE');
        if (report.status === 'SENT') sent++;
        else failed++;
      } catch (error) {
        failed++;
        this.deps.logger.error('Falha no envio mensal ao contador', {
          tenantId: tenant.id,
          error: String(error),
        });
      }
    }
    return { sent, failed };
  }

  history(tenantId: string): Promise<AccountantReport[]> {
    return this.deps.reports.listByTenant(tenantId, 24);
  }

  private async notifyCompany(
    tenant: Tenant,
    period: string,
    report: AccountantReport
  ): Promise<void> {
    await this.deps.email
      .send({
        to: tenant.email,
        subject: `Enviamos ao seu contador as notas de ${monthLabel(period)}`,
        text: `As ${report.invoiceCount} nota(s) de ${monthLabel(period)} (${formatBRL(report.totalCents)}) foram enviadas ao seu contador por ${report.channels.join(' e ').toLowerCase()}.`,
        html: `<p>As <b>${report.invoiceCount}</b> nota(s) de ${monthLabel(period)} (${formatBRL(report.totalCents)}) foram enviadas ao seu contador.</p>`,
        attachments: [],
      })
      .catch(() => undefined);
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
