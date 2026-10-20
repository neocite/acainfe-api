import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness, sampleCompany } from '../../../test/support/app-harness.js';
import { NOW } from '../../../test/support/fixtures.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import { generateTestPfx } from '../../../test/support/test-certificate.js';
import { createCoverage } from '../../domain/tenant/coverage.js';

describe('numeração das notas e notas de outro sistema', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];

  const sale = (externalId: string, customer = { taxId: '52998224725', name: 'Maria' }) =>
    h.sales.register(tenant, {
      source: 'API',
      externalId,
      customer,
      items: [{ productExternalId: 'sup', totalCents: 15000 }],
    });

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
  });

  it('quem já emite por outro sistema recebe série exclusiva; mesma série nunca volta para trás', async () => {
    expect(await h.tenants.setNumbering(tenant.id, { issuesElsewhere: true })).toEqual({
      series: '900',
      nextNumber: 1,
    });
    expect((await sale('a')).invoices[0].dps).toMatchObject({ series: '900', number: 1 });
    expect((await sale('a2')).invoices[0].dps.id).toMatch(
      /^DPS354870821122233300018100900000000000000002$/
    );

    await expect(h.tenants.setNumbering(tenant.id, { nextNumber: 2 })).rejects.toThrow(
      /já usou até o número 2/
    );
    expect(await h.tenants.setNumbering(tenant.id, { series: '1', nextNumber: 48750 })).toEqual({
      series: '1',
      nextNumber: 48750,
    });
    expect((await sale('b')).invoices[0].dps).toMatchObject({ series: '1', number: 48750 });
    await expect(h.tenants.setNumbering(tenant.id, { series: '123456' })).rejects.toThrow(
      /1 a 5 dígitos/
    );
    await expect(h.tenants.setNumbering(tenant.id, { nextNumber: 0 })).rejects.toThrow(
      /inteiro positivo/
    );
    expect((await h.repos.tenants.findById(tenant.id))!.numberingConfirmedAt).toBeDefined();
  });

  it('DPS duplicado com nota de OUTRA venda: não adota, rejeita com conflito e renumera ao reprocessar', async () => {
    const { invoices } = await sale('c');
    h.provider.behaviours = ['DUPLICATE'];
    h.provider.existing = {
      ...sampleNfse('777'),
      amountCents: 99_99,
      customerDocument: '11144477735',
    };
    const rejected = (await h.invoices.issue(invoices[0].id))!;
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      lastErrors: [{ code: 'DPS_NUMBER_CONFLICT' }],
    });
    expect(rejected.nfse).toBeUndefined();
    expect((await h.invoices.explain(tenant.id, invoices[0].id)).hints[0]).toMatch(
      /set_invoice_numbering/
    );

    await h.tenants.setNumbering(tenant.id, { issuesElsewhere: true });
    const retried = await h.invoices.retry(tenant.id, invoices[0].id);
    expect(retried.dps).toMatchObject({ series: '900', number: 1 });
    expect(retried.sentToProvider).toBe(false);
    h.provider.existing = null;
    expect((await h.invoices.issue(invoices[0].id))!.status).toBe('ISSUED');
  });

  it('DPS duplicado da PRÓPRIA venda (timeout anterior) é adotado normalmente', async () => {
    const { invoices } = await sale('d');
    h.provider.behaviours = ['DUPLICATE'];
    h.provider.existing = {
      ...sampleNfse('55'),
      amountCents: 15000,
      customerDocument: '52998224725',
    };
    expect((await h.invoices.issue(invoices[0].id))!.nfse!.number).toBe('55');
  });

  it('consulta prévia após timeout também confere a nota', async () => {
    const { invoices } = await sale('e');
    h.provider.behaviours = ['DOWN'];
    await h.invoices.issue(invoices[0].id);
    h.clock.advance(60_000);
    h.provider.existing = { ...sampleNfse('9'), amountCents: 1, customerDocument: '' };
    expect((await h.invoices.issue(invoices[0].id))!.lastErrors![0].code).toBe(
      'DPS_NUMBER_CONFLICT'
    );
  });

  it('estorno não adota nota alheia encontrada pelo DPS', async () => {
    const { invoices, sale: s } = await sale('f');
    h.provider.behaviours = ['DOWN'];
    await h.invoices.issue(invoices[0].id);
    h.provider.existing = { ...sampleNfse('1'), amountCents: 1 };
    const r = await h.refunds.refundSale(tenant, { saleId: s.id }, { requestedBy: 'API' });
    expect(r.invoices[0].outcome).toBe('CANCELLED_BEFORE_ISSUE');
  });

  it('onboarding pergunta a numeração e produtos importados recebem a sugestão do serviço padrão', async () => {
    const h2 = buildAppHarness();
    await h2.repos.coverage.upsert(
      createCoverage({ cityCode: '3548708', simples: true, others: false }, NOW)
    );
    h2.registry.companies.set('11222333000181', sampleCompany());
    const user = await h2.accounts.identify({ externalId: 'u', email: 'u@x.com' });
    const { pfx, password } = generateTestPfx({ notBefore: new Date(NOW.getTime() - 86_400_000) });
    const { tenant: view } = await h2.onboarding.submitCertificate(user, pfx, password);
    await h2.tenants.update(view.id, {
      defaultService: {
        taxProfile: { nationalServiceCode: '080201', nbsCode: '122051900' },
        serviceDescription: 'Treinamento',
      },
    });
    const done = await h2.onboarding.completeCompany((await h2.repos.tenants.findById(view.id))!, {
      municipalRegistration: '1',
      simplesNacionalTaxRateBps: 600,
      dpsSeries: '1',
      nextDpsNumber: 48750,
    });
    // Sem responder "O que você vende?", os produtos importados só recebem a sugestão do serviço padrão.
    expect(done.readiness.missing.map((m) => m.field)).toEqual(['businessType']);
    expect(done.tenant).toMatchObject({ dpsSeries: '1', lastDpsNumber: 48749 });

    h2.gateway.products = [{ id: 'prod_1', name: 'Curso', recurring: false }];
    const r = await h2.onboarding.connectAbacatePay(
      (await h2.repos.tenants.findById(view.id))!,
      h2.gateway.validKey
    );
    expect(r.pendingTaxReview[0].suggestedTaxProfile).toMatchObject({
      nationalServiceCode: '080201',
      nbsCode: '122051900',
    });
    expect(r.pendingTaxReview[0].taxStatus).toBe('PENDING_REVIEW');

    await h2.tenants.update(view.id, { defaultService: null });
    expect((await h2.repos.tenants.findById(view.id))!.defaultService).toBeUndefined();
  });
});
