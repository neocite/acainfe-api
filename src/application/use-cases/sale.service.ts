import { buildDpsId, Invoice } from '../../domain/invoice/invoice.js';
import { splitSaleIntoInvoices } from '../../domain/invoice/invoice-splitter.js';
import {
  isSellable,
  Product,
  productExternalIds,
  saleBlockers,
} from '../../domain/product/product.js';
import { createCustomer, CustomerInput } from '../../domain/sale/customer.js';
import { createHeldSale, createSale, Sale, SaleItem, SaleSource } from '../../domain/sale/sale.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { allocateProportionally, assertCents } from '../../domain/shared/money.js';
import { Tenant, tenantReadiness } from '../../domain/tenant/tenant.js';
import {
  InvoiceRepository,
  ProductRepository,
  SaleRepository,
  TenantRepository,
} from '../ports/repositories.js';
import { Clock, IdGenerator, JobScheduler, Logger } from '../ports/services.js';
import { CustomerService } from './customer.service.js';

export interface SaleItemInput {
  /** Id do produto no açaínfe… */
  productId?: string;
  /** …ou o externalId (ex.: id do produto no gateway). */
  productExternalId?: string;
  quantity?: number;
  unitPriceCents?: number;
  totalCents?: number;
  description?: string;
}

export interface RegisterSaleInput {
  source: SaleSource;
  externalId: string;
  /** Cliente cadastrado (tomador). Pode ser combinado com `customer` para sobrescrever dados. */
  customerId?: string;
  customer?: CustomerInput & { externalId?: string };
  items: SaleItemInput[];
  /** Total pago. Obrigatório quando os itens não trazem preço (é rateado pelos preços de referência). */
  totalCents?: number;
  competenceDate?: Date;
  rawPayload?: unknown;
}

export interface RegisterSaleResult {
  sale: Sale;
  invoices: Invoice[];
  duplicated: boolean;
  /** Venda retida aguardando produtos/tributação — vira nota automaticamente depois. */
  held?: boolean;
}

export class SaleService {
  constructor(
    private readonly deps: {
      sales: SaleRepository;
      products: ProductRepository;
      invoices: InvoiceRepository;
      tenants: TenantRepository;
      customers: CustomerService;
      scheduler: JobScheduler;
      clock: Clock;
      ids: IdGenerator;
      logger: Logger;
    }
  ) {}

  /**
   * Registra a venda (idempotente por origem+externalId), divide em NFS-e por perfil tributário
   * e agenda a emissão assíncrona. Retorna imediatamente — a prefeitura pode estar fora do ar.
   * Com `holdIfNotReady` (webhooks), produtos não cadastrados/sem tributação retêm a venda em vez de falhar.
   */
  async register(
    tenant: Tenant,
    input: RegisterSaleInput,
    options: { holdIfNotReady?: boolean } = {}
  ): Promise<RegisterSaleResult> {
    if (tenant.status !== 'ACTIVE') {
      throw DomainError.invalidState(
        `A empresa está na lista de espera (${tenant.waitlist?.reason ?? 'município em integração'}); avisaremos quando liberar`
      );
    }
    const existing = await this.deps.sales.findByExternalId(
      tenant.id,
      input.source,
      input.externalId,
      tenant.environment
    );
    if (existing) return this.existingResult(tenant.id, existing);

    if (!input.items?.length) throw DomainError.validation('A venda precisa de ao menos um item');
    createCustomer(input.customer); // valida antes de qualquer efeito colateral
    const { products, problems } = await this.resolveProducts(tenant, input.items);
    if (problems.length && !options.holdIfNotReady) {
      throw DomainError.validation(problems.join(' '), { problems });
    }

    const { customer, customerId } = await this.deps.customers.resolveForSale(
      tenant.id,
      input.customerId,
      input.customer
    );
    const now = this.deps.clock.now();
    const id = this.deps.ids.next();
    const sale = problems.length
      ? createHeldSale({
          id,
          tenantId: tenant.id,
          environment: tenant.environment,
          source: input.source,
          externalId: input.externalId,
          customer,
          totalCents: input.totalCents,
          reasons: problems,
          input: { ...input, rawPayload: undefined },
          rawPayload: input.rawPayload,
          createdAt: now,
        })
      : createSale({
          id,
          tenantId: tenant.id,
          environment: tenant.environment,
          source: input.source,
          externalId: input.externalId,
          customer,
          customerId,
          items: this.priceItems(input, products),
          rawPayload: input.rawPayload,
          createdAt: now,
        });

    try {
      await this.deps.sales.create(sale);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONFLICT') {
        const raced = await this.deps.sales.findByExternalId(
          tenant.id,
          input.source,
          input.externalId,
          tenant.environment
        );
        if (raced) return this.existingResult(tenant.id, raced);
      }
      throw error;
    }
    if (sale.held) {
      this.deps.logger.info('Venda retida aguardando produtos', {
        saleId: sale.id,
        reasons: problems,
      });
      return { sale, invoices: [], duplicated: false, held: true };
    }
    return {
      ...(await this.materialize(tenant, sale, products, input.competenceDate ?? now)),
      duplicated: false,
    };
  }

  /**
   * Libera vendas retidas cujos produtos já estão prontos. Chamado ao confirmar/cadastrar produtos
   * e periodicamente pela fila. Retorna quantas vendas viraram notas.
   */
  async resumeHeld(tenantId?: string): Promise<number> {
    let released = 0;
    for (const held of await this.deps.sales.findHeld(tenantId)) {
      if (held.refund) continue; // estornada antes de emitir: nada a fazer
      const tenant = await this.deps.tenants.findById(held.tenantId);
      if (!tenant || tenant.status !== 'ACTIVE') continue;
      const input = held.held!.input as RegisterSaleInput;
      const { products, problems } = await this.resolveProducts(tenant, input.items);
      if (problems.length) continue;
      try {
        const { customerId } = await this.deps.customers.resolveForSale(
          tenant.id,
          input.customerId,
          input.customer
        );
        const sale = createSale({
          id: held.id,
          tenantId: held.tenantId,
          environment: held.environment,
          source: held.source,
          externalId: held.externalId,
          customer: held.customer,
          customerId,
          items: this.priceItems(input, products),
          rawPayload: held.rawPayload,
          createdAt: held.createdAt,
        });
        await this.deps.sales.update(sale);
        await this.materialize(
          tenant,
          sale,
          products,
          input.competenceDate ? new Date(input.competenceDate) : held.createdAt
        );
        released++;
      } catch (error) {
        this.deps.logger.warn('Falha ao liberar venda retida', {
          saleId: held.id,
          error: String(error),
        });
      }
    }
    return released;
  }

  private async materialize(
    tenant: Tenant,
    sale: Sale,
    products: Map<number, Product>,
    competenceDate: Date
  ): Promise<Omit<RegisterSaleResult, 'duplicated'>> {
    const now = this.deps.clock.now();
    const byId = new Map([...products.values()].map((p) => [p.id, p]));
    const drafts = splitSaleIntoInvoices(sale, byId);
    const { first: firstNumber, series } = await this.deps.tenants.reserveDpsNumbers(
      tenant.id,
      drafts.length
    );
    const invoices: Invoice[] = drafts.map((draft, index) => {
      const number = firstNumber + index;
      return {
        id: this.deps.ids.next(),
        tenantId: tenant.id,
        saleId: sale.id,
        environment: tenant.environment,
        customer: sale.customer,
        items: draft.items,
        taxProfile: draft.taxProfile,
        serviceDescription: draft.serviceDescription,
        amountCents: draft.amountCents,
        competenceDate,
        dps: {
          series,
          number,
          id: buildDpsId(tenant.cityCode, tenant.cnpj, series, number),
        },
        status: 'PENDING',
        attempts: 0,
        deliveries: [],
        history: [
          { at: now, event: 'CREATED', message: `Venda ${sale.externalId} (${sale.source})` },
        ],
        createdAt: now,
        updatedAt: now,
      };
    });
    await this.deps.invoices.createMany(invoices);
    await this.deps.sales.setInvoiceIds(
      sale.id,
      invoices.map((i) => i.id)
    );
    for (const invoice of invoices) {
      // Falha ao agendar não perde a nota: o reconciliador varre PENDING periodicamente.
      await this.deps.scheduler.scheduleIssue(invoice.id).catch((error: unknown) =>
        this.deps.logger.warn('Falha ao agendar emissão; reconciliador irá retomar', {
          invoiceId: invoice.id,
          error: String(error),
        })
      );
    }
    return { sale: { ...sale, invoiceIds: invoices.map((i) => i.id) }, invoices };
  }

  async get(tenantId: string, saleId: string): Promise<RegisterSaleResult> {
    const sale = await this.deps.sales.findById(tenantId, saleId);
    if (!sale) throw DomainError.notFound('Venda', saleId);
    return this.existingResult(tenantId, sale);
  }

  private async existingResult(tenantId: string, sale: Sale): Promise<RegisterSaleResult> {
    const page = await this.deps.invoices.list(tenantId, { saleId: sale.id, pageSize: 100 });
    return { sale, invoices: page.items, duplicated: true, held: Boolean(sale.held) };
  }

  /**
   * Mapeia cada item (por productId ou externalId) para o produto cadastrado. Chave = índice do item.
   * `problems` lista produtos ausentes ou ainda sem tributação confirmada.
   */
  private async resolveProducts(
    tenant: Tenant,
    items: SaleItemInput[]
  ): Promise<{ products: Map<number, Product>; problems: string[] }> {
    const tenantId = tenant.id;
    const ids = items.map((i) => i.productId).filter((v): v is string => Boolean(v));
    const externalIds = items
      .map((i) => i.productExternalId)
      .filter((v): v is string => Boolean(v));
    const [byId, byExternal] = await Promise.all([
      ids.length ? this.deps.products.findManyByIds(tenantId, ids) : Promise.resolve([]),
      externalIds.length
        ? this.deps.products.findManyByExternalIds(tenantId, externalIds)
        : Promise.resolve([]),
    ]);
    const idMap = new Map(byId.map((p) => [p.id, p]));
    // Um produto pode responder por vários ids do gateway (duplicados unificados na importação).
    const extMap = new Map(
      byExternal.flatMap((p) => productExternalIds(p).map((e) => [e, p] as const))
    );
    const products = new Map<number, Product>();
    // Pendências do cadastro da empresa também seguram a venda (o certificado é checado na emissão,
    // que tenta de novo até ele chegar).
    const problems: string[] = tenantReadiness(tenant, true).missing.map((m) => m.message);
    items.forEach((item, index) => {
      const product = item.productId
        ? idMap.get(item.productId)
        : extMap.get(item.productExternalId ?? '');
      const ref = item.productId ?? item.productExternalId ?? '(sem identificação)';
      if (!product) {
        problems.push(
          `Produto não cadastrado: ${ref}. Cadastre-o com seu código de serviço antes de emitir.`
        );
      } else if (!isSellable(product)) {
        problems.push(...saleBlockers(product));
      } else {
        products.set(index, product);
      }
    });
    return { products, problems };
  }

  private priceItems(input: RegisterSaleInput, products: Map<number, Product>): SaleItem[] {
    const lines = input.items.map((item, index) => {
      const product = products.get(index)!;
      const quantity = item.quantity ?? 1;
      const explicit =
        item.totalCents ??
        (item.unitPriceCents !== undefined ? item.unitPriceCents * quantity : undefined);
      return { item, product, quantity, explicit };
    });

    if (lines.every((l) => l.explicit !== undefined)) {
      const items = lines.map((l) => ({
        productId: l.product.id,
        quantity: l.quantity,
        totalCents: assertCents(l.explicit!, 'totalCents'),
        description: l.item.description,
      }));
      if (input.totalCents !== undefined) {
        const sum = items.reduce((s, i) => s + i.totalCents, 0);
        if (sum !== input.totalCents) {
          throw DomainError.validation('A soma dos itens difere do total da venda', {
            sum,
            totalCents: input.totalCents,
          });
        }
      }
      return items;
    }

    if (input.totalCents === undefined) {
      throw DomainError.validation('Informe o preço de cada item ou o totalCents da venda');
    }
    // Gateway informou só o total: rateia pelo preço de referência dos produtos (ou igualmente).
    const fixed = lines.reduce((s, l) => s + (l.explicit ?? 0), 0);
    const pending = lines.filter((l) => l.explicit === undefined);
    const shares = allocateProportionally(
      assertCents(input.totalCents - fixed, 'totalCents'),
      pending.map((l) => (l.product.defaultPriceCents ?? 0) * l.quantity)
    );
    let cursor = 0;
    return lines.map((l) => ({
      productId: l.product.id,
      quantity: l.quantity,
      totalCents: l.explicit ?? shares[cursor++],
      description: l.item.description,
    }));
  }
}
