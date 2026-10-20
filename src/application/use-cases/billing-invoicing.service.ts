import { periodRange, previousPeriod } from '../../domain/accounting/accountant-report.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { BillingRepository, TenantRepository } from '../ports/repositories.js';
import { Clock, Logger } from '../ports/services.js';
import { SaleService } from './sale.service.js';

export interface BillingInvoicingConfig {
  /** CNPJ da empresa que opera o açaínfe e emite a nota do uso (ex.: EXTRACTIFY). */
  issuerCnpj?: string;
  /** externalId do produto "prestação de serviço açaí nfe" na empresa emissora. */
  productExternalId?: string;
}

export type BillingInvoicingResult = {
  period: string;
  /** Vendas registradas agora (viram nota pelo fluxo normal). */
  registered: number;
  /** Já registradas antes (job rodou de novo). */
  alreadyRegistered: number;
  /** Retidas aguardando produto/tributação — viram nota sozinhas quando liberar. */
  held: number;
  failed: { tenantId: string; error: string }[];
};

const monthLabel = (period: string): string => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

/**
 * Nota mensal do uso do açaínfe (orientação da contabilidade): uma NFS-e por cliente e mês, com o
 * total das notas emitidas no período — canceladas depois também contam —, pago ou não. A empresa
 * operadora emite com o produto configurado e o cliente como tomador. Idempotente por cliente+mês.
 */
export class BillingInvoicingService {
  constructor(
    private readonly deps: {
      billing: BillingRepository;
      tenants: TenantRepository;
      sales: SaleService;
      clock: Clock;
      logger: Logger;
      config: BillingInvoicingConfig;
    }
  ) {}

  get enabled(): boolean {
    return Boolean(this.deps.config.issuerCnpj && this.deps.config.productExternalId);
  }

  /** Job diário: fecha o mês anterior. Rodar de novo só registra o que faltou. */
  async runMonthly(): Promise<BillingInvoicingResult | null> {
    if (!this.enabled) return null;
    return this.invoicePeriod(previousPeriod(this.deps.clock.now()));
  }

  async invoicePeriod(period: string): Promise<BillingInvoicingResult> {
    const { issuerCnpj, productExternalId } = this.deps.config;
    if (!issuerCnpj || !productExternalId) {
      throw DomainError.invalidState(
        'Nota mensal do açaínfe desligada: configure BILLING_INVOICE_ISSUER_CNPJ e BILLING_INVOICE_PRODUCT_EXTERNAL_ID'
      );
    }
    const { from, to } = periodRange(period);
    if (to > this.deps.clock.now()) {
      throw DomainError.validation(`O mês ${monthLabel(period)} ainda não terminou`);
    }
    const issuer = await this.deps.tenants.findByCnpj(issuerCnpj.replace(/\D/g, ''));
    if (!issuer) throw DomainError.notFound('Empresa emissora', issuerCnpj);

    const result: BillingInvoicingResult = {
      period,
      registered: 0,
      alreadyRegistered: 0,
      held: 0,
      failed: [],
    };
    // A operadora não emite nota para si mesma (e é isso que impede o laço da cobrança).
    const usages = (await this.deps.billing.usageByTenant(from, to)).filter(
      (u) => u.tenantId !== issuer.id
    );
    for (const usage of usages) {
      try {
        const client = await this.deps.tenants.findById(usage.tenantId);
        if (!client) throw DomainError.notFound('Empresa', usage.tenantId);
        const sale = await this.deps.sales.register(
          issuer,
          {
            source: 'ACAINFE_BILLING',
            externalId: `billing_${period}_${client.id}`,
            customer: {
              taxId: client.cnpj,
              name: client.legalName,
              email: client.email,
              phone: client.phone,
              address: client.address,
            },
            items: [
              {
                productExternalId,
                totalCents: usage.totalCents,
                description: `Uso do açaínfe (emissor de NFS-e): ${usage.invoiceCount} nota(s) emitida(s) em ${monthLabel(period)}`,
              },
            ],
            totalCents: usage.totalCents,
            competenceDate: from,
          },
          { holdIfNotReady: true }
        );
        if (sale.duplicated) result.alreadyRegistered++;
        else if (sale.held) result.held++;
        else result.registered++;
      } catch (error) {
        result.failed.push({ tenantId: usage.tenantId, error: String(error) });
        this.deps.logger.error('Falha na nota mensal do açaínfe', {
          tenantId: usage.tenantId,
          period,
          error: String(error),
        });
      }
    }
    return result;
  }
}
