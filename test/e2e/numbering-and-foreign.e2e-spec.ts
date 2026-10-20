import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAgainstXsd } from '../support/xsd.js';
import { findNonIntegerNumbers } from './support/integer-guard.js';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

describe('Numeração (migração de outro emissor) e tomador no exterior', () => {
  let ctx: E2EApp;
  let apiKey: string;
  const http = () => request(ctx.baseUrl);
  const getInvoice = (id: string) =>
    http()
      .get(`/v1/invoices/${id}`)
      .set('x-api-key', apiKey)
      .then((r) => r.body);

  beforeAll(async () => {
    ctx = await startE2EApp();
    ({ apiKey } = await onboardTenant(ctx));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('número já usado por outro sistema: não adota a nota alheia; série exclusiva + reprocessar resolve', async () => {
    // O eNotas já emitiu a nota nº 1 da série 1 para outro cliente.
    ctx.sefin.preloadForeignNote(
      'DPS354870821122233300018100001000000000000001',
      '99.90',
      '11144477735'
    );
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId: 'mig-1',
        customer: { taxId: '52998224725', name: 'Maria' },
        items: [{ productExternalId: 'prod_suporte', totalCents: 15000 }],
      })
      .expect(202);
    const id = res.body.invoices[0].id;
    const rejected = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'REJECTED'
    );
    expect(rejected.lastErrors[0].code).toBe('DPS_NUMBER_CONFLICT');
    expect(rejected.nfse).toBeUndefined();
    expect(ctx.email.sent.filter((m) => m.to === 'maria@x.com')).toHaveLength(0);

    const numbering = await http()
      .put('/v1/tenants/me/numbering')
      .set('x-api-key', apiKey)
      .send({ issuesElsewhere: true })
      .expect(200);
    expect(numbering.body).toEqual({ series: '900', nextNumber: 1 });
    await http().post(`/v1/invoices/${id}/retry`).set('x-api-key', apiKey).expect(202);
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.dps).toMatchObject({ series: '900', number: 1 });
  });

  it('venda para cliente no exterior vira exportação de serviço (DPS válido no XSD)', async () => {
    const before = ctx.sefin.dpsXmls.length;
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId: 'export-1',
        customer: {
          name: 'John Smith',
          email: 'john@example.com',
          foreign: { countryCode: 'US', nif: '123-45-6789' },
        },
        items: [{ productExternalId: 'prod_consultoria', totalCents: 50000 }],
      })
      .expect(202);
    await eventually(
      () => getInvoice(res.body.invoices[0].id),
      (b) => b.status === 'ISSUED'
    );
    const xml = ctx.sefin.dpsXmls.slice(before).at(-1)!;
    expect(xml).toContain('<NIF>123-45-6789</NIF>');
    expect(xml).toContain('<tribISSQN>3</tribISSQN><cPaisResult>US</cPaisResult>');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
    const customers = await http()
      .get('/v1/customers?search=john')
      .set('x-api-key', apiKey)
      .expect(200);
    expect(customers.body.items[0].foreign).toMatchObject({ countryCode: 'US' });
  });

  it('tributos aproximados no texto da nota e alerta de produto sem NBS', async () => {
    await http()
      .patch('/v1/tenants/me')
      .set('x-api-key', apiKey)
      .send({
        approximateTaxes: {
          rateBps: 1553,
          descriptionTemplate: 'Valor aprox. dos tributos: R$ [ValorTributos]. Fonte: IBPT',
        },
      })
      .expect(200);
    const before = ctx.sefin.dpsXmls.length;
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId: 'ibpt-1',
        items: [{ productExternalId: 'prod_suporte', totalCents: 10000 }],
      })
      .expect(202);
    await eventually(
      () => getInvoice(res.body.invoices[0].id),
      (b) => b.status === 'ISSUED'
    );
    expect(ctx.sefin.dpsXmls.slice(before).at(-1)).toContain(
      'Valor aprox. dos tributos: R$ 15,53. Fonte: IBPT'
    );

    const semNbs = await http()
      .post('/v1/products')
      .set('x-api-key', apiKey)
      .send({ name: 'Sem NBS', taxProfile: { nationalServiceCode: '010701' } })
      .expect(201);
    expect(semNbs.body.warnings[0]).toMatch(/NBS/);
  });
  it('todos os valores numéricos persistidos são inteiros (centavos, pontos-base)', async () => {
    expect(await findNonIntegerNumbers(ctx.container.db)).toEqual([]);
  });
});
