import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';

describe('SaleService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      defaultPriceCents: 10000,
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
    await h.products.create(tenant, {
      name: 'Curso',
      externalId: 'curso',
      defaultPriceCents: 30000,
      taxProfile: { nationalServiceCode: '080201' },
    });
  });

  it('divide a venda em uma nota por código de serviço e agenda a emissão', async () => {
    const result = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'pedido-1',
      customer: { email: 'cliente@x.com' },
      items: [
        { productExternalId: 'sup', unitPriceCents: 5000, quantity: 2 },
        { productExternalId: 'curso', totalCents: 30000 },
      ],
    });
    expect(result.duplicated).toBe(false);
    expect(result.invoices).toHaveLength(2);
    expect(result.invoices.map((i) => i.dps.number)).toEqual([1, 2]);
    expect(result.invoices.map((i) => i.amountCents).sort()).toEqual([10000, 30000]);
    expect(h.scheduler.issues.map((s) => s.invoiceId).sort()).toEqual(
      result.invoices.map((i) => i.id).sort()
    );
    expect(result.sale.invoiceIds).toHaveLength(2);
  });

  it('é idempotente pelo externalId da origem', async () => {
    const input = {
      source: 'ABACATEPAY' as const,
      externalId: 'bill_1',
      items: [{ productExternalId: 'sup', totalCents: 100 }],
    };
    const first = await h.sales.register(tenant, input);
    const second = await h.sales.register(tenant, input);
    expect(second.duplicated).toBe(true);
    expect(second.sale.id).toBe(first.sale.id);
    expect(second.invoices.map((i) => i.id)).toEqual(first.invoices.map((i) => i.id));
    expect(h.repos.invoices.items.size).toBe(1);
  });

  it('rateia o total pelo preço de referência quando o gateway só informa o total', async () => {
    const result = await h.sales.register(tenant, {
      source: 'ABACATEPAY',
      externalId: 'chk_1',
      totalCents: 36000,
      items: [{ productExternalId: 'sup' }, { productExternalId: 'curso' }],
    });
    const byCode = Object.fromEntries(
      result.invoices.map((i) => [i.taxProfile.nationalServiceCode, i.amountCents])
    );
    expect(byCode).toEqual({ '010701': 9000, '080201': 27000 });
  });

  it('valida soma dos itens contra o total e exige preço ou total', async () => {
    await expect(
      h.sales.register(tenant, {
        source: 'API',
        externalId: 'a',
        totalCents: 1,
        items: [{ productExternalId: 'sup', totalCents: 2 }],
      })
    ).rejects.toThrow(/difere/);
    await expect(
      h.sales.register(tenant, {
        source: 'API',
        externalId: 'b',
        items: [{ productExternalId: 'sup' }],
      })
    ).rejects.toThrow(/preço de cada item/);
  });

  it('explica quando o produto não está cadastrado', async () => {
    await expect(
      h.sales.register(tenant, {
        source: 'API',
        externalId: 'c',
        items: [{ productExternalId: 'nao-existe', totalCents: 100 }],
      })
    ).rejects.toThrow(/Produto não cadastrado: nao-existe/);
    await expect(
      h.sales.register(tenant, { source: 'API', externalId: 'd', items: [] })
    ).rejects.toThrow(/ao menos um item/);
  });

  it('não perde a venda se a fila estiver indisponível (reconciliador retoma)', async () => {
    h.scheduler.fail = true;
    const result = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'e',
      items: [{ productExternalId: 'sup', totalCents: 100 }],
    });
    expect(result.invoices[0].status).toBe('PENDING');
    expect(h.logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('consulta venda com suas notas', async () => {
    const created = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'f',
      items: [{ productExternalId: 'sup', totalCents: 100 }],
    });
    const found = await h.sales.get(tenant.id, created.sale.id);
    expect(found.invoices).toHaveLength(1);
    await expect(h.sales.get(tenant.id, 'nope')).rejects.toThrow(/não encontrado/);
  });
});
