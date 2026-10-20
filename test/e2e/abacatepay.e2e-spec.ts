import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABACATEPAY_PUBLIC_HMAC_KEY } from '../../src/adapters/in/webhooks/abacatepay.service.js';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

const checkoutCompleted = (
  id: string,
  items: { id: string; quantity: number }[],
  amount: number
) => ({
  id: `log_${id}`,
  event: 'checkout.completed',
  apiVersion: 2,
  devMode: true,
  data: {
    checkout: {
      id,
      externalId: 'pedido-x',
      amount,
      paidAmount: amount,
      items,
      status: 'PAID',
      methods: ['PIX'],
    },
    customer: {
      id: 'cust_1',
      name: 'João Silva',
      email: 'joao@exemplo.com',
      taxId: '123.***.***-**',
    },
  },
});

describe('Webhook AbacatePay', () => {
  let ctx: E2EApp;
  let apiKey: string;
  let path: string;
  const http = () => request(ctx.baseUrl);
  const post = (payload: object, query = path) => {
    const raw = JSON.stringify(payload);
    const sig = createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY).update(raw).digest('base64');
    return http()
      .post(query)
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sig)
      .send(raw);
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    // Eventos de teste (devMode) só valem para empresa em homologação.
    ({ apiKey } = await onboardTenant(ctx, undefined, 'HOMOLOGATION'));
    const res = await http()
      .post('/v1/tenants/me/integrations/abacatepay')
      .set('x-api-key', apiKey)
      .expect(201);
    const url = new URL(res.body.webhookUrl);
    expect(url.origin).toBe('https://api.acainfe.test');
    path = `${url.pathname}${url.search}`;
    // Com apiKey no corpo, a mesma rota conecta pela key (webhook, produtos e pagamentos antigos).
    const invalid = await http()
      .post('/v1/tenants/me/integrations/abacatepay')
      .set('x-api-key', apiKey)
      .send({ apiKey: 'chave-invalida-123' })
      .expect(422);
    expect(invalid.body.message).toMatch(/inválida/);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('checkout pago com 2 produtos de códigos diferentes → 2 notas, rateando o total', async () => {
    const res = await post(
      checkoutCompleted(
        'bill_100',
        [
          { id: 'prod_suporte', quantity: 1 },
          { id: 'prod_consultoria', quantity: 1 },
        ],
        20000
      )
    ).expect(200);
    expect(res.body.status).toBe('ACCEPTED');
    expect(res.body.invoiceIds).toHaveLength(2);

    const list = await eventually(
      () =>
        http()
          .get('/v1/invoices?status=ISSUED')
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.total === 2
    );
    const amounts = list.items
      .map((i: { amountCents: number }) => i.amountCents)
      .sort((a: number, b: number) => a - b);
    expect(amounts).toEqual([5000, 15000]);
    await eventually(
      async () => ctx.email.sent.length,
      (n) => n === 2
    );
    expect(ctx.email.sent[0].to).toBe('joao@exemplo.com');
  });

  it('retentativa do mesmo evento é idempotente', async () => {
    const payload = checkoutCompleted('bill_100', [{ id: 'prod_suporte', quantity: 1 }], 20000);
    const res = await post(payload).expect(200);
    expect(res.body.invoiceIds).toHaveLength(2);
    expect(await ctx.container.db.collection('sales').countDocuments()).toBe(1);
  });

  it('rejeita segredo ou assinatura inválidos', async () => {
    const payload = checkoutCompleted('bill_200', [{ id: 'prod_suporte', quantity: 1 }], 100);
    await post(payload, path.replace(/webhookSecret=[^&]+/, 'webhookSecret=errado')).expect(401);
    await http().post(path).set('X-Webhook-Signature', 'forjada').send(payload).expect(401);
  });

  it('ignora eventos que não geram nota', async () => {
    const res = await post({ event: 'checkout.refunded', data: {} }).expect(200);
    expect(res.body.status).toBe('IGNORED');
  });

  it('Pix transparente: produto do metadata; sem ele, só com o produto padrão da empresa', async () => {
    const pix = (id: string, metadata?: Record<string, string>) => ({
      id: `log_${id}`,
      event: 'transparent.completed',
      devMode: true,
      data: {
        transparent: { id, amount: 3000, paidAmount: 3000, status: 'PAID', metadata },
        customer: { name: 'Ana', email: 'ana@exemplo.com' },
      },
    });
    const withMetadata = await post(
      pix('pix_meta', { productExternalId: 'prod_consultoria' })
    ).expect(200);
    expect(withMetadata.body).toMatchObject({ status: 'ACCEPTED', invoiceIds: [expect.any(String)] });

    const noProduct = await post(pix('pix_sem_produto')).expect(200);
    expect(noProduct.body.status).toBe('IGNORED');

    const products = await http().get('/v1/products').set('x-api-key', apiKey).expect(200);
    const suporte = products.body.items.find(
      (p: { externalId: string }) => p.externalId === 'prod_suporte'
    );
    const set = await http()
      .put('/v1/tenants/me/integrations/abacatepay/default-product')
      .set('x-api-key', apiKey)
      .send({ productId: suporte.id })
      .expect(200);
    expect(set.body.defaultProduct).toEqual({ decided: true, productId: suporte.id });
    // "Nenhum": productId volta explicitamente null no JSON (o app compara com o que enviou).
    const none = await http()
      .put('/v1/tenants/me/integrations/abacatepay/default-product')
      .set('x-api-key', apiKey)
      .send({ productId: null })
      .expect(200);
    expect(none.body.defaultProduct).toEqual({ decided: true, productId: null });
    await http()
      .put('/v1/tenants/me/integrations/abacatepay/default-product')
      .set('x-api-key', apiKey)
      .send({ productId: suporte.id })
      .expect(200);

    const withDefault = await post(pix('pix_padrao')).expect(200);
    expect(withDefault.body.status).toBe('ACCEPTED');
    const invoice = await http()
      .get(`/v1/invoices/${withDefault.body.invoiceIds[0]}`)
      .set('x-api-key', apiKey)
      .expect(200);
    expect(invoice.body).toMatchObject({
      amountCents: 3000,
      items: [expect.objectContaining({ productId: suporte.id })],
    });
  });

  it('produto não cadastrado: venda fica retida e vira nota quando o produto é cadastrado', async () => {
    const held = await post(
      checkoutCompleted('bill_300', [{ id: 'prod_novo', quantity: 1 }], 100)
    ).expect(200);
    expect(held.body).toMatchObject({
      status: 'HELD',
      reasons: [expect.stringMatching(/não cadastrado/)],
    });
    await http()
      .post('/v1/products')
      .set('x-api-key', apiKey)
      .send({
        name: 'Novo',
        externalId: 'prod_novo',
        taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900' },
      })
      .expect(201);
    const sale = await eventually(
      () =>
        http()
          .get(`/v1/sales/${held.body.saleId}`)
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.invoices.length === 1 && b.invoices[0].status === 'ISSUED'
    );
    expect(sale.invoices[0].amountCents).toBe(100);
    // Reentrega do mesmo evento continua idempotente.
    const again = await post(
      checkoutCompleted('bill_300', [{ id: 'prod_novo', quantity: 1 }], 100)
    ).expect(200);
    expect(again.body.status).toBe('ACCEPTED');
  });

  it('renovação de assinatura (subscription.renewed) gera nota', async () => {
    const res = await post({
      event: 'subscription.renewed',
      data: {
        subscription: { id: 'subs_1', amount: 2990, status: 'ACTIVE' },
        customer: { id: 'cust_sub', name: 'Assinante', email: 'assinante@x.com' },
        checkout: {
          id: 'bill_renew_1',
          amount: 2990,
          paidAmount: 2990,
          items: [{ id: 'prod_suporte', quantity: 1 }],
        },
      },
    }).expect(200);
    expect(res.body.status).toBe('ACCEPTED');
    expect(res.body.invoiceIds).toHaveLength(1);
  });
});
