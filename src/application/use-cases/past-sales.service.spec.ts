import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness, sampleCompany } from '../../../test/support/app-harness.js';
import { NOW } from '../../../test/support/fixtures.js';
import { generateTestPfx } from '../../../test/support/test-certificate.js';
import { createCoverage } from '../../domain/tenant/coverage.js';
import { Tenant } from '../../domain/tenant/tenant.js';

const DAY = 86_400_000;

describe('Vendas passadas (antes do açaínfe)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;

  const reload = async () => (tenant = (await h.repos.tenants.findById(tenant.id))!);

  beforeEach(async () => {
    h = buildAppHarness();
    await h.repos.coverage.upsert(
      createCoverage({ cityCode: '3548708', simples: true, others: false }, NOW)
    );
    h.registry.companies.set('11222333000181', sampleCompany());
    const user = await h.accounts.identify({ externalId: 'u', email: 'u@x.com' });
    const { pfx, password } = generateTestPfx({ notBefore: new Date(NOW.getTime() - DAY) });
    const { tenant: view } = await h.onboarding.submitCertificate(user, pfx, password);
    await h.tenants.setNumbering(view.id, { issuesElsewhere: false });
    await h.tenants.update(view.id, { businessType: 'INFOPRODUCER' });
    tenant = (await h.repos.tenants.findById(view.id))!;

    h.gateway.products = [{ id: 'prod_curso', name: 'Curso', priceCents: 9700, recurring: false }];
    h.gateway.customers = [
      {
        id: 'cust_1',
        name: 'Maria',
        email: 'maria@x.com',
        taxId: '529.982.247-25',
        phone: '11999990000',
      },
    ];
    h.gateway.charges = [
      // NOW = 18/10/2026: outubro é o mês atual
      {
        id: 'bill_out1',
        kind: 'CHECKOUT',
        status: 'PAID',
        paidAt: new Date('2026-10-05T15:00:00Z'),
        amountCents: 9700,
        items: [{ productExternalId: 'prod_curso', quantity: 1 }],
        customerId: 'cust_1',
      },
      {
        id: 'bill_out2',
        kind: 'SUBSCRIPTION',
        status: 'PAID',
        paidAt: new Date('2026-10-10T15:00:00Z'),
        amountCents: 9700,
        items: [{ productExternalId: 'prod_curso', quantity: 1 }],
      },
      {
        id: 'pix_out3',
        kind: 'TRANSPARENT',
        status: 'PAID',
        paidAt: new Date('2026-10-11T15:00:00Z'),
        amountCents: 5000,
        items: [],
      },
      {
        id: 'bill_set1',
        kind: 'CHECKOUT',
        status: 'PAID',
        paidAt: new Date('2026-09-20T15:00:00Z'),
        amountCents: 9700,
        items: [{ productExternalId: 'prod_curso', quantity: 1 }],
      },
      {
        id: 'bill_set2',
        kind: 'CHECKOUT',
        status: 'REFUNDED',
        paidAt: new Date('2026-09-21T15:00:00Z'),
        amountCents: 9700,
        items: [{ productExternalId: 'prod_curso', quantity: 1 }],
      },
    ];
  });

  it('ao conectar o AbacatePay já mostra a prévia por mês, sem emitir nada', async () => {
    const r = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    expect(r.pastSales).toEqual({
      periods: [
        {
          period: '2026-10',
          isCurrentMonth: true,
          requiresConfirmation: false,
          available: { count: 3, totalCents: 24400, withoutItems: 1 },
          alreadyIssued: 0,
          imported: 0,
          refunded: 0,
          ignored: 0,
        },
        {
          period: '2026-09',
          isCurrentMonth: false,
          requiresConfirmation: true,
          available: { count: 1, totalCents: 9700, withoutItems: 0 },
          alreadyIssued: 0,
          imported: 0,
          refunded: 1,
          ignored: 0,
        },
      ],
    });
    expect(h.repos.invoices.items.size).toBe(0);
  });

  it('reconectar (nova key) não cria outro webhook nem troca o segredo', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    const secret = (await reload()).integrations.abacatepay!.webhookSecret;
    const again = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    expect(h.gateway.webhooks).toHaveLength(1);
    expect(again.webhookId).toBe('webh_1');
    expect((await reload()).integrations.abacatepay!.webhookSecret).toBe(secret);
  });

  it('key sem permissão de leitura: conecta normalmente e avisa', async () => {
    h.gateway.canReadCharges = false;
    const r = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    expect(r.webhookId).toBe('webh_1');
    expect(r.pastSales).toEqual({ warning: expect.stringContaining('CHECKOUT:READ') });
  });

  it('mês atual: emite as disponíveis; marcadas como já emitidas e Pix sem item ficam de fora', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    const curso = (await h.products.list(tenant.id, {})).items[0];
    await h.products.confirmTax(
      tenant,
      curso.id,
      { nationalServiceCode: '080201' },
      { userConfirmed: true, via: 'API' }
    );

    const items = await h.pastSales.list(tenant, { period: '2026-10', status: ['AVAILABLE'] });
    await h.pastSales.setAlreadyIssued(
      tenant,
      { ids: [items.find((i) => i.externalId === 'bill_out2')!.id] },
      true
    );

    // Sem cruzar com as notas da prefeitura, a emissão é recusada (risco de duplicidade).
    await expect(h.pastSales.issue(tenant, { period: '2026-10' })).rejects.toThrow(
      /reconcile_past_sales/
    );
    await h.pastSales.reconcile(tenant, '2026-10');
    const r = await h.pastSales.issue(tenant, { period: '2026-10' });
    expect(r).toEqual({
      period: '2026-10',
      issued: 1,
      held: 0,
      skippedWithoutProduct: 1,
      failed: [],
    });
    const sale = (await h.repos.sales.findByExternalId(
      tenant.id,
      'ABACATEPAY',
      'bill_out1',
      tenant.environment
    ))!;
    expect(sale.customer).toMatchObject({
      name: 'Maria',
      email: 'maria@x.com',
      taxId: { value: '52998224725' },
    });
    const [invoice] = (await h.invoices.list(tenant.id, { saleId: sale.id })).items;
    expect(invoice.competenceDate).toEqual(new Date('2026-10-05T15:00:00Z')); // competência = data da venda
    expect(
      await h.repos.sales.findByExternalId(tenant.id, 'ABACATEPAY', 'bill_out2', tenant.environment)
    ).toBeNull();

    // Pix avulso entra com produto escolhido pelo usuário.
    const pix = await h.pastSales.issue(tenant, { period: '2026-10', fallbackProductId: curso.id });
    expect(pix).toMatchObject({ issued: 1, skippedWithoutProduct: 0 });

    // Webhook atrasado da mesma cobrança não duplica.
    const dup = await h.sales.register(tenant, {
      source: 'ABACATEPAY',
      externalId: 'bill_out1',
      totalCents: 9700,
      items: [{ productExternalId: 'prod_curso' }],
    });
    expect(dup.duplicated).toBe(true);
  });

  it('meses anteriores exigem confirmação explícita (competência retroativa)', async () => {
    // Perfil microSaaS ainda não validado: o produto importado só recebe sugestão.
    await h.tenants.update(tenant.id, { businessType: 'MICROSAAS' });
    await reload();
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    await expect(h.pastSales.issue(tenant, { period: '2026-09' })).rejects.toThrow(
      /retificar o PGDAS/
    );
    await expect(
      h.pastSales.issue(tenant, { period: '2026-11', confirmPastPeriod: true })
    ).rejects.toThrow(/futuro/);
    // Produto sem tributação: a venda fica retida (vira nota quando o usuário confirmar o produto).
    const r = await h.pastSales.issue(tenant, {
      period: '2026-09',
      confirmPastPeriod: true,
      skipReconciliation: true,
    });
    expect(r).toMatchObject({ issued: 0, held: 1 });
    const summary = await h.pastSales.summary(tenant);
    expect(summary.find((p) => p.period === '2026-09')).toMatchObject({ imported: 1, refunded: 1 });
  });

  it('nova varredura não duplica e reflete vendas que viraram nota pelo webhook', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    expect((await h.pastSales.scan(tenant)).inserted).toBe(0);
    await expect(h.pastSales.scan(tenant, 13)).rejects.toThrow(/entre 0 e 12/);
    await expect(h.pastSales.setAlreadyIssued(tenant, {}, true)).rejects.toThrow(/ids ou period/);
    expect((await h.pastSales.setAlreadyIssued(tenant, { period: '2026-10' }, true)).updated).toBe(
      3
    );
    expect((await h.pastSales.setAlreadyIssued(tenant, { period: '2026-10' }, false)).updated).toBe(
      3
    );
  });

  it('Pix sem item usa o produto padrão da empresa', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    const curso = (await h.products.list(tenant.id, {})).items[0];
    await h.products.confirmTax(
      tenant,
      curso.id,
      { nationalServiceCode: '080201' },
      { userConfirmed: true, via: 'API' }
    );
    await h.onboarding.setDefaultProduct(tenant, curso.id);
    await reload();
    await h.pastSales.reconcile(tenant, '2026-10');
    const r = await h.pastSales.issue(tenant, { period: '2026-10' });
    expect(r).toMatchObject({ issued: 3, skippedWithoutProduct: 0 });
    const pix = (await h.repos.sales.findByExternalId(
      tenant.id,
      'ABACATEPAY',
      'pix_out3',
      tenant.environment
    ))!;
    expect(pix.items).toEqual([expect.objectContaining({ productId: curso.id, totalCents: 5000 })]);
  });

  it('pagamentos de teste podem ser ignorados: não emitem, sobrevivem à nova varredura e voltam se desfeito', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    const [pix] = await h.pastSales
      .list(tenant, { period: '2026-10', status: ['AVAILABLE'] })
      .then((items) => items.filter((i) => i.externalId === 'pix_out3'));
    expect(
      await h.pastSales.setIgnored(tenant, { ids: [pix.id] }, true, 'pagamento de teste')
    ).toEqual({ updated: 1 });
    expect((await h.pastSales.setIgnored(tenant, { period: '2026-09' }, true)).updated).toBe(1);

    await h.pastSales.scan(tenant);
    const [ignored] = await h.pastSales.list(tenant, { status: ['IGNORED'], period: '2026-10' });
    expect(ignored).toMatchObject({ externalId: 'pix_out3', ignoredReason: 'pagamento de teste' });
    expect((await h.pastSales.summary(tenant)).find((p) => p.period === '2026-09')).toMatchObject({
      available: { count: 0 },
      ignored: 1,
      refunded: 1,
    });
    const r = await h.pastSales.issue(tenant, {
      period: '2026-09',
      confirmPastPeriod: true,
      skipReconciliation: true,
    });
    expect(r).toMatchObject({ issued: 0, held: 0 });

    expect((await h.pastSales.setIgnored(tenant, { ids: [pix.id] }, false)).updated).toBe(1);
    const [back] = await h.pastSales
      .list(tenant, { status: ['AVAILABLE'], period: '2026-10' })
      .then((items) => items.filter((i) => i.externalId === 'pix_out3'));
    expect(back.ignoredReason).toBeUndefined();
  });

  it('exige AbacatePay conectado', async () => {
    await expect(h.pastSales.scan(tenant)).rejects.toThrow(/Conecte o AbacatePay/);
  });

  it('cruza com as notas da prefeitura, sugere e só marca o que o usuário confirmar', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    // bill_out1 (Maria, CPF) já tem nota emitida pelo eNotas; bill_out2 bate só por valor e data.
    h.provider.municipalNotes = [
      {
        number: '48600',
        issuedAt: new Date('2026-10-05T18:00:00Z'),
        amountCents: 9700,
        customerDocument: '52998224725',
        customerName: 'Maria',
        rps: { number: '700', series: '1' },
      },
      {
        number: '48650',
        issuedAt: new Date('2026-10-12T12:00:00Z'),
        amountCents: 9700,
        customerName: 'Outra pessoa',
        rps: { number: '701', series: '1' },
      },
    ];
    const r = await h.pastSales.reconcile(tenant, '2026-10');
    expect(r.summary).toEqual({
      high: 1,
      medium: 0,
      low: 1,
      withoutNote: 1, // Pix sem item (5000) não tem nota
      municipalNotesWithoutSale: 0,
    });
    const high = r.matches.find((m) => m.confidence === 'HIGH')!;
    expect(high).toMatchObject({ externalId: 'bill_out1', nfse: { number: '48600' } });
    // Reconciliar não altera status.
    expect((await h.pastSales.summary(tenant))[0].available.count).toBe(3);

    const applied = await h.pastSales.applyReconciliation(tenant, {
      period: '2026-10',
      confidence: 'HIGH',
    });
    expect(applied).toEqual({ marked: 1, remainingAvailable: 2 });
    const [marked] = await h.pastSales.list(tenant, {
      period: '2026-10',
      status: ['ALREADY_ISSUED'],
    });
    expect(marked).toMatchObject({
      externalId: 'bill_out1',
      matchedNfse: { number: '48600', confidence: 'HIGH' },
    });
    // MEDIUM não inclui LOW; ids limitam ao que o usuário confirmou.
    expect(
      await h.pastSales.applyReconciliation(tenant, { period: '2026-10', confidence: 'MEDIUM' })
    ).toMatchObject({ marked: 0 });
  });
});
