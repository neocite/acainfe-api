import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABACATEPAY_PUBLIC_HMAC_KEY } from '../../src/adapters/in/webhooks/abacatepay.service.js';
import { generateTestPfx } from '../support/test-certificate.js';
import { validateAgainstXsd } from '../support/xsd.js';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

describe('Estorno, logo e upload de certificado', () => {
  let ctx: E2EApp;
  let apiKey: string;
  const http = () => request(ctx.baseUrl);
  const issuedSale = async (externalId: string) => {
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId,
        customer: { email: 'cliente@x.com' },
        items: [
          { productExternalId: 'prod_suporte', totalCents: 1000 },
          { productExternalId: 'prod_consultoria', totalCents: 2000 },
        ],
      })
      .expect(202);
    await eventually(
      () =>
        http()
          .get(`/v1/sales/${res.body.sale.id}`)
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.invoices.every((i: { status: string }) => i.status === 'ISSUED')
    );
    return res.body.sale.id as string;
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    ({ apiKey } = await onboardTenant(ctx));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('POST /v1/sales/:id/refund cancela as notas emitidas na prefeitura', async () => {
    const saleId = await issuedSale('r-1');
    const res = await http()
      .post(`/v1/sales/${saleId}/refund`)
      .set('x-api-key', apiKey)
      .send({})
      .expect(201);
    expect(res.body.invoices.map((i: { outcome: string }) => i.outcome)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(ctx.sefin.events).toHaveLength(2);
    for (const xml of ctx.sefin.events) {
      expect(xml).toContain('<cMotivo>2</cMotivo>');
      expect(await validateAgainstXsd(xml, 'pedRegEvento_v1.01.xsd')).toEqual([]);
    }
    const again = await http()
      .post(`/v1/sales/${saleId}/refund`)
      .set('x-api-key', apiKey)
      .send({})
      .expect(201);
    expect(again.body.invoices.every((i: { outcome: string }) => i.outcome === 'CANCELLED')).toBe(
      true
    );
    expect(ctx.sefin.events).toHaveLength(2);
  });

  it('estorno pelo externalId antes da emissão: notas não chegam a ser emitidas', async () => {
    ctx.sefin.mode = 'DOWN';
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({ externalId: 'r-2', items: [{ productExternalId: 'prod_suporte', totalCents: 500 }] })
      .expect(202);
    await eventually(
      () =>
        http()
          .get(`/v1/invoices/${res.body.invoices[0].id}`)
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.status === 'RETRYING'
    );
    ctx.sefin.mode = 'OK';
    const refund = await http()
      .post('/v1/sales/by-external-id/r-2/refund')
      .set('x-api-key', apiKey)
      .send({ reasonCode: '9', reason: 'Cliente desistiu da compra' })
      .expect(201);
    // Já tinha sido enviada (timeout): consulta o DPS, não encontra e encerra sem emitir.
    expect(refund.body.invoices[0].outcome).toBe('CANCELLED_BEFORE_ISSUE');
    const inv = await http()
      .get(`/v1/invoices/${res.body.invoices[0].id}`)
      .set('x-api-key', apiKey)
      .expect(200);
    expect(inv.body).toMatchObject({ status: 'CANCELLED', cancellation: { beforeIssue: true } });
    await http()
      .post('/v1/sales/by-external-id/nao-existe/refund')
      .set('x-api-key', apiKey)
      .send({})
      .expect(404);
  });

  it('webhook checkout.refunded do AbacatePay cancela as notas', async () => {
    const link = await http()
      .post('/v1/tenants/me/integrations/abacatepay')
      .set('x-api-key', apiKey)
      .expect(201);
    const url = new URL(link.body.webhookUrl);
    const post = (payload: object) => {
      const raw = JSON.stringify(payload);
      return http()
        .post(`${url.pathname}${url.search}`)
        .set('Content-Type', 'application/json')
        .set(
          'X-Webhook-Signature',
          createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY).update(raw).digest('base64')
        )
        .send(raw);
    };
    const checkout = {
      id: 'bill_refund',
      amount: 10000,
      paidAmount: 10000,
      items: [{ id: 'prod_suporte', quantity: 1 }],
    };
    await post({
      event: 'checkout.completed',
      data: { checkout, customer: { id: 'cust_9', name: 'Ana', email: 'ana@x.com' } },
    }).expect(200);
    await eventually(
      () =>
        http()
          .get('/v1/invoices?status=ISSUED')
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.items.some((i: { amountCents: number }) => i.amountCents === 10000)
    );
    const before = ctx.sefin.events.length;
    const res = await post({ event: 'checkout.refunded', data: { checkout } }).expect(200);
    expect(res.body).toMatchObject({ status: 'REFUNDED', invoices: [{ outcome: 'CANCELLED' }] });
    expect(ctx.sefin.events.length).toBe(before + 1);

    const unknown = await post({
      event: 'checkout.refunded',
      data: { checkout: { id: 'bill_x' } },
    }).expect(200);
    expect(unknown.body.status).toBe('IGNORED');

    // O cliente do gateway foi cadastrado automaticamente.
    const customers = await http()
      .get('/v1/customers?search=ana')
      .set('x-api-key', apiKey)
      .expect(200);
    expect(customers.body.items[0]).toMatchObject({ externalId: 'cust_9', email: 'ana@x.com' });
  });

  it('logo da empresa aparece no PDF', async () => {
    const list = await http()
      .get('/v1/invoices?status=CANCELLED')
      .set('x-api-key', apiKey)
      .expect(200);
    const id = list.body.items.find((i: { nfse?: unknown }) => i.nfse).id;
    const pdfOf = async () =>
      (
        await http()
          .get(`/v1/invoices/${id}/pdf`)
          .set('x-api-key', apiKey)
          .buffer(true)
          .parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
          })
          .expect(200)
      ).body as Buffer;
    const without = await pdfOf();

    await http()
      .put('/v1/tenants/me/logo')
      .set('x-api-key', apiKey)
      .attach('file', Buffer.from('não é imagem'), 'x.png')
      .expect(422);
    await http()
      .put('/v1/tenants/me/logo')
      .set('x-api-key', apiKey)
      .attach('file', PNG, 'logo.png')
      .expect(200);
    const logo = await http().get('/v1/tenants/me/logo').set('x-api-key', apiKey).expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect((await pdfOf()).length).toBeGreaterThan(without.length);

    await http()
      .put('/v1/tenants/me/logo')
      .set('x-api-key', apiKey)
      .send({ imageUrl: 'http://127.0.0.1/logo.png' })
      .expect(422);
    await http().delete('/v1/tenants/me/logo').set('x-api-key', apiKey).expect(204);
    await http().get('/v1/tenants/me/logo').set('x-api-key', apiKey).expect(404);
  });

  it('página de upload do certificado via link temporário', async () => {
    const link = await http()
      .post('/v1/certificates/upload-link')
      .set('x-api-key', apiKey)
      .expect(201);
    const path = new URL(link.body.url).pathname;
    const page = await http().get(path).expect(200);
    expect(page.text).toContain('Empresa E2E LTDA');
    expect(page.text).toContain('type="file"');

    const { pfx, password } = generateTestPfx();
    const wrong = await http()
      .post(path)
      .field('password', 'errada')
      .attach('file', pfx, 'c.pfx')
      .expect(422);
    expect(wrong.text).toMatch(/senha incorreta/);
    const ok = await http()
      .post(path)
      .field('password', password)
      .attach('file', pfx, 'c.pfx')
      .expect(200);
    expect(ok.text).toContain('Certificado recebido');

    await http().get('/v1/public/certificate-upload/tenant.123.forjado').expect(410);
  });
});
