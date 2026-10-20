import {
  atLeast,
  currentPeriod,
  MATCH_WINDOW,
  MatchConfidence,
  matchPastSalesWithMunicipal,
  MunicipalNote,
  markAlreadyIssued,
  markIgnored,
  PAST_PERIOD_WARNING,
  PastSale,
  PastSalesPeriodSummary,
  summarizePastSales,
} from '../../domain/backfill/past-sale.js';
import { periodRange } from '../../domain/accounting/accountant-report.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import { PastSaleRepository, SaleRepository } from '../ports/repositories.js';
import {
  Clock,
  IdGenerator,
  Logger,
  PaymentGatewayAdmin,
  SecretCipher,
} from '../ports/services.js';
import { SaleService } from './sale.service.js';

const BRT_OFFSET_MS = -3 * 3_600_000;
const periodOf = (d: Date): string =>
  new Date(d.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 7);

/** Início do mês que está `monthsBack` meses antes do mês atual (Brasília). */
function monthsBackStart(now: Date, monthsBack: number): Date {
  const [y, m] = currentPeriod(now).split('-').map(Number);
  const idx = y * 12 + (m - 1) - monthsBack;
  return periodRange(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`).from;
}

export interface IssuePastSalesResult {
  period: string;
  issued: number;
  held: number;
  skippedWithoutProduct: number;
  /** Vendas que não puderam ser emitidas (ex.: dado inválido vindo do gateway); as demais seguem. */
  failed: { externalId: string; message: string }[];
}

export const NOT_RECONCILED_WARNING =
  'Este mês ainda não foi cruzado com as notas que a prefeitura já tem. Se alguma venda já teve nota emitida por outro sistema (ex.: eNotas), ela sairá em duplicidade. Use reconcile_past_sales antes ou confirme com skipReconciliation: true.';

/**
 * Vendas pagas no AbacatePay antes do açaínfe: varre o histórico, mostra a prévia por mês,
 * deixa o usuário marcar o que já tem nota em outro sistema e emite o restante.
 */
export class PastSalesService {
  constructor(
    private readonly deps: {
      pastSales: PastSaleRepository;
      sales: SaleRepository;
      saleService: SaleService;
      gateway: PaymentGatewayAdmin;
      cipher: SecretCipher;
      clock: Clock;
      ids: IdGenerator;
      logger: Logger;
      /** Notas já emitidas na prefeitura (por qualquer sistema) — para cruzar antes de emitir. */
      municipalInvoices?: {
        listMunicipal(tenant: Tenant, range: { from: Date; to: Date }): Promise<MunicipalNote[]>;
        canListMunicipal(tenant: Tenant): boolean;
      };
    }
  ) {}

  /**
   * Cruza as vendas disponíveis do mês com as notas que a prefeitura já tem (ex.: emitidas pelo
   * eNotas). Só sugere: nada é marcado aqui. Registra que o mês foi conferido.
   */
  async reconcile(tenant: Tenant, period: string) {
    const { sales, result } = await this.match(tenant, period);
    const now = this.deps.clock.now();
    for (const sale of sales) {
      await this.deps.pastSales.update({ ...sale, reconciledAt: now, updatedAt: now });
    }
    const view = (m: (typeof result.matches)[number]) => ({
      pastSaleId: m.pastSale.id,
      externalId: m.pastSale.externalId,
      paidAt: m.pastSale.paidAt,
      amountCents: m.pastSale.amountCents,
      customer: m.pastSale.customer,
      confidence: m.confidence,
      nfse: {
        number: m.note.number,
        issuedAt: m.note.issuedAt,
        customerName: m.note.customerName,
        customerDocument: m.note.customerDocument,
      },
    });
    return {
      period,
      matches: result.matches.map(view),
      unmatched: result.unmatched.map((s) => ({
        pastSaleId: s.id,
        externalId: s.externalId,
        paidAt: s.paidAt,
        amountCents: s.amountCents,
        customer: s.customer,
      })),
      summary: {
        high: result.matches.filter((m) => m.confidence === 'HIGH').length,
        medium: result.matches.filter((m) => m.confidence === 'MEDIUM').length,
        low: result.matches.filter((m) => m.confidence === 'LOW').length,
        withoutNote: result.unmatched.length,
        municipalNotesWithoutSale: result.unusedNotes.length,
      },
    };
  }

  /**
   * Marca como "já emitida" as vendas que correspondem a notas da prefeitura, no nível de
   * confiança pedido (ou acima) e, se informado, só os ids confirmados pelo usuário.
   * Refaz o cruzamento: não confia em resultados antigos.
   */
  async applyReconciliation(
    tenant: Tenant,
    input: { period: string; confidence: Exclude<MatchConfidence, 'LOW'>; ids?: string[] }
  ): Promise<{ marked: number; remainingAvailable: number }> {
    const { result } = await this.match(tenant, input.period);
    const now = this.deps.clock.now();
    let marked = 0;
    for (const m of result.matches) {
      if (!atLeast(m.confidence, input.confidence)) continue;
      if (input.ids && !input.ids.includes(m.pastSale.id)) continue;
      await this.deps.pastSales.update(
        markAlreadyIssued(m.pastSale, true, now, {
          number: m.note.number,
          issuedAt: m.note.issuedAt,
          confidence: m.confidence,
        })
      );
      marked++;
    }
    const remaining = await this.deps.pastSales.list(tenant.id, {
      period: input.period,
      status: ['AVAILABLE'],
    });
    return { marked, remainingAvailable: remaining.length };
  }

  private async match(tenant: Tenant, period: string) {
    if (!this.deps.municipalInvoices) {
      throw DomainError.validation('Consulta de notas na prefeitura indisponível');
    }
    const { from, to } = periodRange(period);
    await this.syncEnvironment(tenant);
    const sales = await this.deps.pastSales.list(tenant.id, { period });
    const notes = await this.deps.municipalInvoices.listMunicipal(tenant, {
      from: new Date(from.getTime() - MATCH_WINDOW.beforeMs),
      to: new Date(Math.min(to.getTime() + MATCH_WINDOW.afterMs, this.deps.clock.now().getTime())),
    });
    return { sales, result: matchPastSalesWithMunicipal(sales, notes) };
  }

  private apiKey(tenant: Tenant): string {
    const encrypted = tenant.integrations.abacatepay?.encryptedApiKey;
    if (!encrypted)
      throw DomainError.validation(
        'Conecte o AbacatePay com sua API key antes de buscar vendas passadas'
      );
    return this.deps.cipher.decrypt(encrypted).toString('utf8');
  }

  /** Busca no AbacatePay as vendas dos últimos `monthsBack` meses (mais o atual) e atualiza a prévia. */
  async scan(
    tenant: Tenant,
    monthsBack = 3
  ): Promise<{ inserted: number; periods: PastSalesPeriodSummary[] }> {
    if (!Number.isInteger(monthsBack) || monthsBack < 0 || monthsBack > 12) {
      throw DomainError.validation('monthsBack deve ser um inteiro entre 0 e 12');
    }
    const key = this.apiKey(tenant);
    const now = this.deps.clock.now();
    const charges = await this.deps.gateway.listCharges(key, {
      from: monthsBackStart(now, monthsBack),
      to: now,
    });
    const customers = new Map((await this.deps.gateway.listCustomers(key)).map((c) => [c.id, c]));

    const candidates: PastSale[] = [];
    for (const charge of charges) {
      const existing = await this.deps.sales.findByExternalId(
        tenant.id,
        'ABACATEPAY',
        charge.id,
        tenant.environment
      );
      const customer = charge.customerId ? customers.get(charge.customerId) : undefined;
      candidates.push({
        id: this.deps.ids.next(),
        tenantId: tenant.id,
        source: 'ABACATEPAY',
        kind: charge.kind,
        externalId: charge.id,
        paidAt: charge.paidAt,
        period: periodOf(charge.paidAt),
        amountCents: charge.amountCents,
        items: charge.items,
        customer: {
          externalId: customer?.id,
          name: customer?.name,
          email: customer?.email,
          taxId: customer?.taxId,
          phone: customer?.phone,
        },
        status: charge.status === 'REFUNDED' ? 'REFUNDED' : existing ? 'IMPORTED' : 'AVAILABLE',
        saleId: existing?.id,
        importedEnvironment: existing ? tenant.environment : undefined,
        createdAt: now,
        updatedAt: now,
      });
    }
    const { inserted } = await this.deps.pastSales.upsertMany(candidates);
    return { inserted, periods: await this.summary(tenant) };
  }

  async summary(tenant: Tenant): Promise<PastSalesPeriodSummary[]> {
    await this.syncEnvironment(tenant);
    const all = await this.deps.pastSales.list(tenant.id, {});
    return summarizePastSales(all, currentPeriod(this.deps.clock.now()));
  }

  async list(
    tenant: Tenant,
    filter: { period?: string; status?: PastSale['status'][] }
  ): Promise<PastSale[]> {
    await this.syncEnvironment(tenant);
    return this.deps.pastSales.list(tenant.id, filter);
  }

  /**
   * Vendas importadas em homologação não têm valor fiscal: quando a empresa passa para produção,
   * elas voltam a ficar disponíveis para emitir de verdade (e vice-versa).
   */
  private async syncEnvironment(tenant: Tenant): Promise<void> {
    for (const past of await this.deps.pastSales.list(tenant.id, { status: ['IMPORTED'] })) {
      const environment =
        past.importedEnvironment ??
        (past.saleId
          ? (await this.deps.sales.findById(tenant.id, past.saleId))?.environment
          : undefined) ??
        tenant.environment;
      if (environment === tenant.environment) continue;
      await this.deps.pastSales.update({
        ...past,
        status: 'AVAILABLE',
        saleId: undefined,
        importedEnvironment: undefined,
        updatedAt: this.deps.clock.now(),
      });
    }
  }

  /** O usuário marca (ou desmarca) vendas que já têm nota emitida em outro sistema. */
  async setAlreadyIssued(
    tenant: Tenant,
    target: { ids?: string[]; period?: string },
    alreadyIssued: boolean
  ): Promise<{ updated: number }> {
    if (!target.ids?.length && !target.period)
      throw DomainError.validation('Informe ids ou period');
    await this.syncEnvironment(tenant);
    const candidates = await this.deps.pastSales.list(tenant.id, {
      period: target.period,
      status: ['AVAILABLE', 'ALREADY_ISSUED', 'IGNORED'],
    });
    const selected = target.ids ? candidates.filter((c) => target.ids!.includes(c.id)) : candidates;
    for (const sale of selected)
      await this.deps.pastSales.update(
        markAlreadyIssued(sale, alreadyIssued, this.deps.clock.now())
      );
    return { updated: selected.length };
  }

  /** O usuário ignora (ou volta a considerar) pagamentos que não são venda, ex.: testes. */
  async setIgnored(
    tenant: Tenant,
    target: { ids?: string[]; period?: string },
    ignored: boolean,
    reason?: string
  ): Promise<{ updated: number }> {
    if (!target.ids?.length && !target.period)
      throw DomainError.validation('Informe ids ou period');
    await this.syncEnvironment(tenant);
    const candidates = await this.deps.pastSales.list(tenant.id, {
      period: target.period,
      status: ignored ? ['AVAILABLE', 'ALREADY_ISSUED'] : ['IGNORED'],
    });
    const selected = target.ids ? candidates.filter((c) => target.ids!.includes(c.id)) : candidates;
    for (const sale of selected)
      await this.deps.pastSales.update(markIgnored(sale, ignored, this.deps.clock.now(), reason));
    return { updated: selected.length };
  }

  /**
   * Emite as vendas disponíveis de um mês. Mês anterior ao atual exige `confirmPastPeriod` (ciência da
   * competência retroativa). Pix avulso sem itens usa `fallbackProductId` ou o produto padrão da
   * empresa; sem nenhum, fica de fora.
   */
  async issue(
    tenant: Tenant,
    input: {
      period: string;
      confirmPastPeriod?: boolean;
      fallbackProductId?: string;
      /** Emite sem cruzar com as notas da prefeitura (o usuário assume o risco de duplicidade). */
      skipReconciliation?: boolean;
    }
  ): Promise<IssuePastSalesResult> {
    periodRange(input.period); // valida AAAA-MM
    if (input.period > currentPeriod(this.deps.clock.now()))
      throw DomainError.validation('Período no futuro');
    if (input.period !== currentPeriod(this.deps.clock.now()) && !input.confirmPastPeriod) {
      throw new DomainError('VALIDATION', PAST_PERIOD_WARNING, {
        requiresConfirmation: true,
        period: input.period,
      });
    }
    await this.syncEnvironment(tenant);
    const result: IssuePastSalesResult = {
      period: input.period,
      issued: 0,
      held: 0,
      skippedWithoutProduct: 0,
      failed: [],
    };
    if (!input.skipReconciliation && this.deps.municipalInvoices?.canListMunicipal(tenant)) {
      const available = await this.deps.pastSales.list(tenant.id, {
        period: input.period,
        status: ['AVAILABLE'],
      });
      if (available.some((s) => !s.reconciledAt)) {
        throw new DomainError('VALIDATION', NOT_RECONCILED_WARNING, {
          requiresReconciliation: true,
          period: input.period,
        });
      }
    }
    const fallbackProductId =
      input.fallbackProductId ?? tenant.integrations.abacatepay?.defaultProductId;
    for (const past of await this.deps.pastSales.list(tenant.id, {
      period: input.period,
      status: ['AVAILABLE'],
    })) {
      if (!past.items.length && !fallbackProductId) {
        result.skippedWithoutProduct++;
        continue;
      }
      try {
        const registered = await this.deps.saleService.register(
          tenant,
          {
            source: 'ABACATEPAY',
            externalId: past.externalId,
            customer: past.customer,
            items: past.items.length
              ? past.items.map((i) => ({
                  productExternalId: i.productExternalId,
                  quantity: i.quantity,
                }))
              : [{ productId: fallbackProductId, quantity: 1 }],
            totalCents: past.amountCents,
            competenceDate: past.paidAt,
            rawPayload: { backfill: true, kind: past.kind },
          },
          { holdIfNotReady: true }
        );
        if (registered.held) result.held++;
        else result.issued++;
        await this.deps.pastSales.update({
          ...past,
          status: 'IMPORTED',
          saleId: registered.sale.id,
          importedEnvironment: tenant.environment,
          updatedAt: this.deps.clock.now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.logger.warn('Falha ao emitir venda passada', {
          externalId: past.externalId,
          error: message,
        });
        result.failed.push({ externalId: past.externalId, message });
      }
    }
    return result;
  }
}
