import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { FISCAL_PROFILES } from '../../domain/product/fiscal-profiles.js';
import { looksLikeTestProduct, productWarnings } from '../../domain/product/product.js';
import { companyIssRateBps, Tenant } from '../../domain/tenant/tenant.js';

describe('Perfis fiscais padrão ("O que você vende?")', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;
  const reload = async () => (tenant = (await h.repos.tenants.findById(tenant.id))!);

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('infoprodutor: produto sem tributação recebe o perfil validado e já pode ser vendido', async () => {
    const p = await h.products.create(
      tenant,
      { name: 'Curso de React', externalId: 'react' },
      'APP'
    );
    expect(p).toMatchObject({
      taxStatus: 'CONFIRMED',
      taxConfirmation: { via: 'PROFILE', note: expect.stringMatching(/Infoprodutor/) },
      taxProfile: {
        nationalServiceCode: '080201',
        localServiceCode: '8.02/103911/1551',
        nbsCode: '122051900',
        issTaxation: 'TAXABLE',
        issRetention: 'NONE',
        issRateBps: 201, // Simples 6% × 33,5%
        ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
      },
    });
    const sale = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'v1',
      items: [{ productExternalId: 'react', totalCents: 9700 }],
    });
    expect(sale.invoices).toHaveLength(1);
  });

  it('microSaaS: perfil ainda não validado entra só como sugestão; o usuário confirma pelo app', async () => {
    await h.tenants.update(tenant.id, { businessType: 'MICROSAAS' });
    await reload();
    const p = await h.products.create(tenant, { name: 'Plano Pro', externalId: 'pro' });
    expect(p).toMatchObject({
      taxStatus: 'PENDING_REVIEW',
      suggestedTaxProfile: {
        nationalServiceCode: '010501',
        nbsCode: '115062100',
        ibsCbs: { operationIndicator: '100501' },
      },
    });
    expect(p.taxProfile).toBeUndefined();
    const confirmed = await h.products.confirmTax(tenant, p.id, p.suggestedTaxProfile!, {
      userConfirmed: true,
      via: 'APP',
    });
    expect(confirmed).toMatchObject({ taxStatus: 'CONFIRMED', taxConfirmation: { via: 'APP' } });
    expect(FISCAL_PROFILES.MICROSAAS.validated).toBe(false);
  });

  it('sem perfil e sem tributação: pede um ou outro', async () => {
    await h.repos.tenants.update({ ...tenant, businessType: undefined });
    await reload();
    await expect(h.products.create(tenant, { name: 'X' })).rejects.toThrow(/businessType/);
  });

  it('NBS: completa quando inequívoco e bloqueia a venda quando falta', async () => {
    // Mesmo código do perfil da empresa → usa o NBS do perfil.
    const curso = await h.products.create(tenant, {
      name: 'Mentoria',
      externalId: 'ment',
      taxProfile: { nationalServiceCode: '080201' },
    });
    expect(curso.taxProfile!.nbsCode).toBe('122051900');

    // Código com várias opções na tabela oficial → fica sem NBS e a venda é bloqueada.
    const suporte = await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701' },
    });
    expect(suporte.taxProfile!.nbsCode).toBeUndefined();
    expect(productWarnings(suporte)[0]).toMatch(/bloqueada/);
    const input = {
      source: 'API' as const,
      externalId: 'v-sup',
      items: [{ productExternalId: 'sup', totalCents: 1000 }],
    };
    await expect(h.sales.register(tenant, input)).rejects.toThrow(/sem código NBS.*115013000/);
    const held = await h.sales.register(tenant, input, { holdIfNotReady: true });
    expect(held.held).toBe(true);

    await h.products.update(tenant, suporte.id, { taxProfile: { nbsCode: '115013000' } });
    expect(await h.sales.resumeHeld(tenant.id)).toBe(1);

    // NBS fora da tabela oficial: só alerta.
    const fora = await h.products.update(tenant, suporte.id, {
      taxProfile: { nbsCode: '122051900' },
    });
    expect(productWarnings(fora)[0]).toMatch(/tabela oficial/);
  });

  it('busca de códigos traz as opções oficiais de NBS e cIndOp', () => {
    const [code] = h.products.searchServiceCodes('instrução treinamento');
    expect(code).toMatchObject({ nationalServiceCode: '080201' });
    expect(code.nbsOptions).toContain('122051900');
    expect(code.operationIndicators).toContain('100301');
  });

  it('pendências do cadastro seguram a venda (readiness.missing)', async () => {
    await h.repos.tenants.update({ ...tenant, businessType: undefined });
    await h.products.create(tenant, {
      name: 'Curso',
      externalId: 'c',
      taxProfile: { nationalServiceCode: '080201', nbsCode: '122051900' },
    });
    await reload();
    const input = {
      source: 'API' as const,
      externalId: 'v',
      items: [{ productExternalId: 'c', totalCents: 1000 }],
    };
    await expect(h.sales.register(tenant, input)).rejects.toThrow(/O que você vende/);
    expect((await h.sales.register(tenant, input, { holdIfNotReady: true })).held).toBe(true);
    await h.onboarding.completeCompany(tenant, { businessType: 'INFOPRODUCER' });
    expect(await h.sales.resumeHeld(tenant.id)).toBe(1);
  });
});

describe('Alíquota de ISS da empresa', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('Simples: calculada pela parcela do ISS (33,5%) e limitada a 2%–5%', () => {
    expect(companyIssRateBps({ ...tenant, simplesNacionalTaxRateBps: 600 })).toBe(201);
    expect(companyIssRateBps({ ...tenant, simplesNacionalTaxRateBps: 400 })).toBe(200);
    expect(companyIssRateBps({ ...tenant, simplesNacionalTaxRateBps: 2_000 })).toBe(500);
    expect(companyIssRateBps({ ...tenant, issRateBps: 300 })).toBe(300);
    expect(companyIssRateBps({ ...tenant, taxRegime: 'LUCRO_PRESUMIDO' })).toBeUndefined();
  });

  it('fora do Simples: usa a alíquota publicada pela prefeitura', async () => {
    h.municipal.issRateBps = 350;
    const status = await h.onboarding.completeCompany(tenant, {
      taxRegime: 'LUCRO_PRESUMIDO',
      businessType: 'INFOPRODUCER',
    });
    expect(status.tenant).toMatchObject({ issRateBps: 350, effectiveIssRateBps: 350 });
    expect(status.readiness.missing.map((m) => m.field)).not.toContain('issRateBps');
  });

  it('fora do Simples e prefeitura sem dado: pergunta ao usuário', async () => {
    h.municipal.issRateBps = null;
    await h.repos.coverage.upsert({
      cityCode: tenant.cityCode,
      simples: true,
      others: true,
      updatedAt: new Date(),
    } as never);
    let status = await h.onboarding.completeCompany(tenant, {
      taxRegime: 'LUCRO_PRESUMIDO',
      businessType: 'INFOPRODUCER',
    });
    expect(status.readiness.missing.map((m) => m.field)).toEqual(['issRateBps']);
    status = await h.onboarding.completeCompany((await h.repos.tenants.findById(tenant.id))!, {
      issRateBps: 500,
    });
    expect(status.readiness.canIssue).toBe(true);
    await expect(
      h.onboarding.completeCompany((await h.repos.tenants.findById(tenant.id))!, {
        issRateBps: 2.5 as never,
      })
    ).rejects.toThrow(/pontos-base/);
  });
});

describe('Importação do AbacatePay com perfil fiscal', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('aplica o perfil, ignora produtos de teste e unifica duplicados pelo nome', async () => {
    h.gateway.products = [
      { id: 'prod_ka1', name: 'Kero Avaliar', priceCents: 4700, recurring: false },
      { id: 'prod_ka2', name: 'kero avaliar ', priceCents: 4700, recurring: false },
      { id: 'prod_t', name: 'Produto Teste', priceCents: 100, recurring: false },
      { id: 'prod_t2', name: 'test checkout', priceCents: 100, recurring: false },
      { id: 'prod_c', name: 'Curso de Vendas', priceCents: 19700, recurring: false },
    ];
    const r = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    expect(r.imported).toBe(2);
    expect(r.confirmedByProfile.map((p) => p.name)).toEqual(['Kero Avaliar', 'Curso de Vendas']);
    expect(r.pendingTaxReview).toEqual([]);
    expect(r.skippedTestProducts).toEqual(['Produto Teste', 'test checkout']);
    expect(r.mergedDuplicates).toEqual([
      { name: 'kero avaliar ', externalId: 'prod_ka2', productId: r.confirmedByProfile[0].id },
    ]);
    const kero = (await h.products.get(tenant.id, r.confirmedByProfile[0].id))!;
    expect(kero.aliasExternalIds).toEqual(['prod_ka2']);

    // Venda do id duplicado cai no mesmo produto.
    const sale = await h.sales.register(tenant, {
      source: 'ABACATEPAY',
      externalId: 'bill_1',
      items: [{ productExternalId: 'prod_ka2', totalCents: 4700 }],
    });
    expect(sale.invoices[0].items[0].productId).toBe(kero.id);

    // Reconectar não duplica nada.
    const again = await h.onboarding.connectAbacatePay(
      (await h.repos.tenants.findById(tenant.id))!,
      h.gateway.validKey
    );
    expect(again).toMatchObject({ imported: 0, mergedDuplicates: [], alreadyExisting: 2 });
  });

  it('heurística de produto de teste', () => {
    expect(looksLikeTestProduct('Teste')).toBe(true);
    expect(looksLikeTestProduct('Produto de testes')).toBe(true);
    expect(looksLikeTestProduct('DEMO')).toBe(true);
    expect(looksLikeTestProduct('Contestação de multas')).toBe(false);
    expect(looksLikeTestProduct('Curso Testando Hipóteses')).toBe(false);
  });
});

describe('Homologação × produção', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;
  const reload = async () => (tenant = (await h.repos.tenants.findById(tenant.id))!);

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.tenants.update(tenant.id, { environment: 'HOMOLOGATION' });
    await reload();
    await h.products.create(tenant, { name: 'Curso', externalId: 'c' });
  });

  it('nota de homologação não é cobrada nem vai ao contador; a mesma venda é emitida de novo em produção', async () => {
    const input = {
      source: 'ABACATEPAY' as const,
      externalId: 'bill_x',
      items: [{ productExternalId: 'c', totalCents: 9700 }],
    };
    const homolog = await h.sales.register(tenant, input);
    expect(homolog.sale.environment).toBe('HOMOLOGATION');
    await h.invoices.issue(homolog.invoices[0].id);
    expect(await h.billing.charge(homolog.invoices[0].id)).toBeNull();
    expect(await h.billing.sweepUnbilled()).toBe(0);
    expect((await h.accountant.buildPackage(tenant, '2026-10')).invoices).toHaveLength(0);
    expect((await h.sales.register(tenant, input)).duplicated).toBe(true);

    await h.tenants.update(tenant.id, { environment: 'PRODUCTION' });
    await reload();
    const prod = await h.sales.register(tenant, input);
    expect(prod.duplicated).toBeFalsy();
    expect(prod.sale.id).not.toBe(homolog.sale.id);
    expect(prod.invoices[0].environment).toBe('PRODUCTION');
    await h.invoices.issue(prod.invoices[0].id);
    expect(await h.billing.charge(prod.invoices[0].id)).toMatchObject({ amountCents: 80 });
  });

  it('vendas passadas importadas em homologação voltam a ficar disponíveis em produção', async () => {
    h.gateway.products = [{ id: 'c', name: 'Curso', recurring: false }];
    h.gateway.charges = [
      {
        id: 'bill_old',
        kind: 'CHECKOUT',
        status: 'PAID',
        paidAt: new Date('2026-10-05T15:00:00Z'),
        amountCents: 9700,
        items: [{ productExternalId: 'c', quantity: 1 }],
      },
    ];
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    expect(
      await h.pastSales.issue(tenant, { period: '2026-10', skipReconciliation: true })
    ).toMatchObject({ issued: 1 });
    expect((await h.pastSales.summary(tenant))[0]).toMatchObject({ imported: 1 });

    await h.tenants.update(tenant.id, { environment: 'PRODUCTION' });
    await reload();
    expect((await h.pastSales.summary(tenant))[0]).toMatchObject({
      imported: 0,
      available: { count: 1 },
    });
    expect(
      await h.pastSales.issue(tenant, { period: '2026-10', skipReconciliation: true })
    ).toMatchObject({ issued: 1 });
  });
});

describe('Sistema de emissão por empresa', () => {
  it('ME/EPP de cidade no Ginfes usa o Ginfes; MEI e a flag da empresa usam o escolhido', async () => {
    const { fiscalSystemFor } = await import('../../domain/tenant/tenant.js');
    const h = buildAppHarness();
    const { tenant } = await h.onboard();
    expect(fiscalSystemFor(tenant, ['3548708'])).toBe('GINFES');
    expect(fiscalSystemFor(tenant, [])).toBe('NACIONAL');
    expect(fiscalSystemFor({ ...tenant, taxRegime: 'MEI' }, ['3548708'])).toBe('NACIONAL');
    expect(fiscalSystemFor({ ...tenant, fiscalProvider: 'NACIONAL' }, ['3548708'])).toBe(
      'NACIONAL'
    );
    expect(fiscalSystemFor({ ...tenant, fiscalProvider: 'GINFES' }, [])).toBe('GINFES');
  });
});

describe('Perfil coerente com os CNAEs e "Outro serviço" (configuro eu mesmo)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;
  const reload = async () => (tenant = (await h.repos.tenants.findById(tenant.id))!);
  const setCnaes = async (codes: string[]) => {
    await h.repos.tenants.update({
      ...tenant,
      cnaes: codes.map((code, i) => ({ code, description: code, primary: i === 0 })),
    });
    await reload();
  };

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('infoprodutor sem CNAE de ensino: produtos entram como sugestão, com aviso', async () => {
    await setCnaes(['6204000', '6201501', '6202300']);
    const p = await h.products.create(tenant, { name: 'Consultoria Design', externalId: 'ux' });
    expect(p).toMatchObject({
      taxStatus: 'PENDING_REVIEW',
      suggestedTaxProfile: { nationalServiceCode: '080201' },
    });
    const settings = await h.fiscalSettings.get(tenant);
    expect(settings.taxDefaults).toMatchObject({
      autoConfirm: false,
      warning: expect.stringMatching(/Nenhum CNAE da empresa é compatível/),
    });
    // Com CNAE de ensino, o perfil validado volta a confirmar sozinho.
    await setCnaes(['8599604', '6204000']);
    const curso = await h.products.create(tenant, { name: 'Curso', externalId: 'curso' });
    expect(curso.taxStatus).toBe('CONFIRMED');
  });

  it('só daqui pra frente: trocar o perfil não mexe em produto já confirmado', async () => {
    const confirmed = await h.products.create(tenant, { name: 'Curso', externalId: 'curso' });
    expect(confirmed.taxStatus).toBe('CONFIRMED');
    await setCnaes(['6204000']);
    await h.onboarding.completeCompany(tenant, { businessType: 'INFOPRODUCER' });
    expect((await h.products.get(tenant.id, confirmed.id)).taxStatus).toBe('CONFIRMED');
  });

  it('"Outro serviço": sem tributação padrão, cada produto pede a sua; com ela, vira sugestão', async () => {
    await h.onboarding.completeCompany(tenant, { businessType: 'CUSTOM' });
    await reload();
    expect(tenant.businessType).toBe('CUSTOM');
    expect((await h.onboarding.status(tenant)).readiness.missing).toEqual([]);
    await expect(h.products.create(tenant, { name: 'UX', externalId: 'ux' })).rejects.toThrow(
      /defaultService/
    );
    const explicit = await h.products.create(tenant, {
      name: 'UX',
      externalId: 'ux',
      taxProfile: { nationalServiceCode: '230101', nbsCode: '114093000', issRateBps: 200 },
    });
    expect(explicit.taxStatus).toBe('CONFIRMED');

    // Importado do AbacatePay antes da tributação padrão: fica pendente, sem sugestão.
    h.gateway.products = [
      { id: 'prod_a', name: 'Mentoria UX', priceCents: 5000, recurring: false },
    ];
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    const [pending] = (await h.products.list(tenant.id, { pendingTaxReview: true })).items;
    expect(pending.suggestedTaxProfile).toBeUndefined();

    // Tributação padrão definida pelo usuário: vira sugestão nos pendentes, nunca confirmação.
    await h.onboarding.completeCompany(await reload(), {
      defaultService: {
        taxProfile: {
          nationalServiceCode: '230101',
          nbsCode: '114093000',
          localServiceCode: '02501',
          issRateBps: 200,
        },
      },
    });
    const suggested = await h.products.get(tenant.id, pending.id);
    expect(suggested).toMatchObject({
      taxStatus: 'PENDING_REVIEW',
      suggestedTaxProfile: { nationalServiceCode: '230101', localServiceCode: '02501' },
    });
    const next = await h.products.create(await reload(), { name: 'Workshop', externalId: 'ws' });
    expect(next).toMatchObject({
      taxStatus: 'PENDING_REVIEW',
      suggestedTaxProfile: { nationalServiceCode: '230101', issRateBps: 200 },
    });
  });
});
