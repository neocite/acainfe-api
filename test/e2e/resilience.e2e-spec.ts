import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

describe('Resiliência: prefeitura indisponível e rejeições', () => {
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

  it('Sefin fora do ar: a venda é aceita, a nota fica RETRYING e emite quando volta (sem duplicar)', async () => {
    ctx.sefin.mode = 'DOWN';
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId: 'offline-1',
        items: [{ productExternalId: 'prod_suporte', totalCents: 9900 }],
      })
      .expect(202);
    const id = res.body.invoices[0].id;

    const retrying = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'RETRYING'
    );
    expect(retrying.lastErrors[0].message).toMatch(/503/);
    expect(new Date(retrying.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    ctx.sefin.mode = 'OK';
    await http().post(`/v1/invoices/${id}/retry`).set('x-api-key', apiKey).expect(202);
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse.number).toBeDefined();

    // Antes de reenviar, consultou o DPS (idempotência) e emitiu uma única vez.
    const paths = ctx.sefin.received.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`GET /dps/${issued.dps.id}`);
    expect(ctx.sefin.dpsXmls).toHaveLength(1);
  });

  it('rejeição da prefeitura: REJECTED com explicação, corrige e reprocessa', async () => {
    ctx.sefin.mode = 'REJECT';
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId: 'reject-1',
        items: [{ productExternalId: 'prod_consultoria', totalCents: 30000 }],
      })
      .expect(202);
    const id = res.body.invoices[0].id;
    const rejected = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'REJECTED'
    );
    expect(rejected.lastErrors[0].code).toBe('E0625');
    expect(rejected.hints.join(' ')).toMatch(/issRateBps/);
    const explained = await http()
      .get(`/v1/invoices/${id}/explain`)
      .set('x-api-key', apiKey)
      .expect(200);
    expect(explained.body.errors[0].complement).toBe('pAliq');

    ctx.sefin.mode = 'OK';
    await http().post(`/v1/invoices/${id}/retry`).set('x-api-key', apiKey).expect(202);
    await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    await http().post(`/v1/invoices/${id}/retry`).set('x-api-key', apiKey).expect(409);
  });

  it('nota de empresa sem certificado é rejeitada com orientação', async () => {
    const { apiKey: noCertKey } = await (async () => {
      const r = await http()
        .post('/v1/tenants')
        .set('x-admin-key', 'admin-key-for-e2e-tests-0123456789')
        .send({
          cnpj: '11444777000161',
          legalName: 'Sem Cert',
          municipalRegistration: '1',
          taxRegime: 'MEI',
          email: 'x@x.com',
          businessType: 'INFOPRODUCER',
        })
        .expect(201);
      return { apiKey: r.body.apiKey as string };
    })();
    await http()
      .post('/v1/products')
      .set('x-api-key', noCertKey)
      .send({
        name: 'X',
        externalId: 'x',
        taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
      })
      .expect(201);
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', noCertKey)
      .send({ externalId: 'nc-1', items: [{ productExternalId: 'x', totalCents: 100 }] })
      .expect(202);
    const inv = await eventually(
      () =>
        http()
          .get(`/v1/invoices/${res.body.invoices[0].id}`)
          .set('x-api-key', noCertKey)
          .then((r) => r.body),
      (b) => b.status === 'REJECTED'
    );
    expect(inv.lastErrors[0].code).toBe('CERTIFICATE_MISSING');
    await http().get('/v1/municipal-params/010701').set('x-api-key', noCertKey).expect(422);
  });

  it('valida entrada da venda', async () => {
    await http().post('/v1/sales').set('x-api-key', apiKey).send({ items: [] }).expect(422);
    const unknown = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({ externalId: 'u-1', items: [{ productExternalId: 'nao-existe', totalCents: 1 }] })
      .expect(422);
    expect(unknown.body.message).toMatch(/Produto não cadastrado/);
  });
});
