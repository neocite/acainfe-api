import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABACATEPAY_PUBLIC_HMAC_KEY } from '../../src/adapters/in/webhooks/abacatepay.service.js';
import { findNonIntegerNumbers } from './support/integer-guard.js';
import {
  ADMIN_KEY,
  BILLING_WEBHOOK_SECRET,
  E2EApp,
  eventually,
  startE2EApp,
} from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

describe('Cobrança interna (R$ por nota emitida)', () => {
  let ctx: E2EApp;
  let apiKey: string;
  let tenantId: string;
  const http = () => request(ctx.baseUrl);
  const summary = () =>
    http()
      .get('/v1/billing')
      .set('x-api-key', apiKey)
      .then((r) => r.body);
  const sell = (externalId: string) =>
    http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({ externalId, items: [{ productExternalId: 'prod_suporte', totalCents: 5000 }] })
      .expect(202)
      .then((r) => r.body.invoices[0].id as string);
  const pixPaid = (id: string, amount: number) => {
    const raw = JSON.stringify({
      id: `log_${id}`,
      event: 'transparent.completed',
      data: { transparent: { id, amount, paidAmount: amount, status: 'PAID' } },
    });
    return http()
      .post(`/v1/webhooks/billing/abacatepay?webhookSecret=${BILLING_WEBHOOK_SECRET}`)
      .set('Content-Type', 'application/json')
      .set(
        'X-Webhook-Signature',
        createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY).update(raw).digest('base64')
      )
      .send(raw);
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    ({ apiKey, tenantId } = await onboardTenant(ctx));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('preço público para a landing page', async () => {
    const res = await http().get('/v1/public/pricing').expect(200);
    expect(res.body).toEqual({
      pricePerInvoiceCents: 80,
      currency: 'BRL',
      monthlyFeeCents: 0,
      graceDays: 7,
    });
  });

  it('documentação pública da API: sem rotas internas, toda operação descrita, /openapi.json e cartão MCP', async () => {
    const res = await http().get('/docs-json').expect(200);
    const paths = Object.keys(res.body.paths);
    expect(paths).toEqual(
      expect.arrayContaining(['/v1/sales', '/v1/invoices/{id}', '/v1/public/coverage'])
    );
    expect(
      paths.filter(
        (p) =>
          p.startsWith('/v1/admin') ||
          p.startsWith('/v1/app') ||
          p.startsWith('/v1/webhooks') ||
          p === '/v1/tenants'
      )
    ).toEqual([]);
    const ops = Object.values(res.body.paths).flatMap((item) =>
      Object.values(item as Record<string, { operationId?: string; summary?: string }>)
    );
    expect(ops.filter((o) => !o.summary)).toEqual([]);
    const ids = ops.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(res.body.info.description).toMatch(/x-api-key/);
    expect(res.body.info.description).toMatch(/curl -X POST/);
    expect(res.body.servers).toEqual([{ url: 'https://api.acainfe.test' }]);

    const openapi = await http().get('/openapi.json').expect(200);
    expect(openapi.headers['content-type']).toMatch(/application\/json/);
    expect(openapi.body).toEqual(res.body);

    const card = await http().get('/.well-known/mcp.json').expect(200);
    expect(card.body).toMatchObject({
      name: 'acainfe',
      transport: { type: 'streamable-http', url: 'https://api.acainfe.test/mcp' },
      authentication: { required: true, schemes: ['bearer'] },
      openapi: 'https://api.acainfe.test/openapi.json',
    });
    expect(JSON.stringify(card.body)).not.toMatch(/admin|x-app-key/i);
  });

  it('cidades atendidas para a landing (só as liberadas, sem autenticação)', async () => {
    for (const [cityCode, body] of [
      ['3550308', { simples: true, others: false, cityName: 'São Paulo', uf: 'SP' }],
      ['3548708', { simples: true, others: false, cityName: 'São Bernardo do Campo', uf: 'SP' }],
      ['3304557', { simples: false, others: false, cityName: 'Rio de Janeiro', uf: 'RJ' }],
    ] as const) {
      await http()
        .put(`/v1/admin/coverage/${cityCode}`)
        .set('x-admin-key', ADMIN_KEY)
        .send(body)
        .expect(200);
    }
    const res = await http().get('/v1/public/coverage').expect(200);
    expect(res.body).toEqual({
      cities: [
        {
          cityCode: '3548708',
          cityName: 'São Bernardo do Campo',
          uf: 'SP',
          regimes: ['MEI', 'SIMPLES_NACIONAL'],
        },
        {
          cityCode: '3550308',
          cityName: 'São Paulo',
          uf: 'SP',
          regimes: ['MEI', 'SIMPLES_NACIONAL'],
        },
      ],
    });
  });

  it('cada NFS-e emitida gera uma cobrança de R$ 0,80', async () => {
    await sell('c-1');
    await sell('c-2');
    const s = await eventually(summary, (b) => b.openCharges === 2);
    expect(s).toMatchObject({
      status: 'OK',
      openCents: 160,
      amountDueCents: 160,
      pricePerInvoiceCents: 80,
      overdue: false,
    });
    const charges = await http().get('/v1/billing/charges').set('x-api-key', apiKey).expect(200);
    expect(
      charges.body.items.every(
        (c: { amountCents: number; nfseNumber: string }) => c.amountCents === 80 && c.nfseNumber
      )
    ).toBe(true);
  });

  it('Pix do saldo pela conta AbacatePay do açaínfe e confirmação via webhook', async () => {
    const pix = await http().post('/v1/billing/payments').set('x-api-key', apiKey).expect(201);
    expect(pix.body).toMatchObject({
      amountCents: 160,
      status: 'PENDING',
      pixCopyPaste: '00020126pix_char_1',
    });
    expect(ctx.external.pixCharges[0]).toMatchObject({
      method: 'PIX',
      data: { amount: 160, metadata: { tenantId } },
    });

    await pixPaid('pix_char_1', 160).set('X-Webhook-Signature', 'forjada').expect(401);
    await http().post('/v1/webhooks/billing/abacatepay?webhookSecret=errado').send({}).expect(401);
    const ok = await pixPaid('pix_char_1', 160).expect(200);
    expect(ok.body.status).toBe('PAID');
    expect(await summary()).toMatchObject({ openCents: 0, amountDueCents: 0 });
    expect((await pixPaid('pix_char_1', 160).expect(200)).body.status).toBe('PAID'); // reentrega idempotente
    expect((await pixPaid('pix_desconhecido', 100).expect(200)).body.status).toBe('IGNORED');
  });

  it('saldo vencido pausa a emissão; pagamento manual (admin) retoma e emite as notas pendentes', async () => {
    // Simula uma cobrança antiga (8 dias) em aberto.
    await ctx.container.db.collection('billing_charges').insertOne({
      _id: randomUUID(),
      tenantId,
      invoiceId: `antiga-${randomUUID()}`,
      amountCents: 80,
      status: 'OPEN',
      createdAt: new Date(Date.now() - 8 * 86_400_000),
    } as never);
    const daily = await ctx.container.billing.daily();
    expect(daily.blocked).toBe(1);
    expect(
      ctx.email.sent.some(
        (m) => /pausada/.test(m.subject) && /desacordo com a legislação/.test(m.text)
      )
    ).toBe(true);
    expect((await summary()).status).toBe('BLOCKED');

    const blocked = await http()
      .get('/v1/admin/billing?status=BLOCKED')
      .set('x-admin-key', ADMIN_KEY)
      .expect(200);
    expect(blocked.body.map((a: { tenantId: string }) => a.tenantId)).toContain(tenantId);

    const invoiceId = await sell('c-3');
    const waiting = await eventually(
      () =>
        http()
          .get(`/v1/invoices/${invoiceId}`)
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.lastErrors?.[0]?.code === 'BILLING_BLOCKED'
    );
    expect(waiting.status).toBe('PENDING');
    expect(waiting.hints.join(' ')).toMatch(/pay_billing/);

    const paid = await http()
      .post(`/v1/admin/billing/${tenantId}/manual-payment`)
      .set('x-admin-key', ADMIN_KEY)
      .send({ amountCents: 80 })
      .expect(201);
    expect(paid.body.status).toBe('OK');
    await eventually(
      () =>
        http()
          .get(`/v1/invoices/${invoiceId}`)
          .set('x-api-key', apiKey)
          .then((r) => r.body),
      (b) => b.status === 'ISSUED'
    );
    await eventually(summary, (b) => b.openCharges === 1); // a nota recém-emitida já gerou nova cobrança
  });

  it('preço negociado e consulta pelo MCP', async () => {
    await http()
      .put(`/v1/admin/billing/${tenantId}/price`)
      .set('x-admin-key', ADMIN_KEY)
      .send({ pricePerInvoiceCents: 50 })
      .expect(200);
    const client = new Client({ name: 'agente', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      })
    );
    const billing = (await client.callTool({ name: 'get_billing', arguments: {} })) as {
      structuredContent: Record<string, unknown>;
    };
    expect(billing.structuredContent).toMatchObject({
      status: 'OK',
      pricePerInvoiceCents: 50,
      openCents: 80,
    });
    const pay = (await client.callTool({ name: 'pay_billing', arguments: {} })) as {
      structuredContent: Record<string, unknown>;
    };
    expect(pay.structuredContent).toMatchObject({
      amountCents: 100,
      pixCopyPaste: expect.stringMatching(/^00020126/),
    });
    await client.close();
  });
  it('todos os valores numéricos persistidos são inteiros (centavos, pontos-base)', async () => {
    expect(await findNonIntegerNumbers(ctx.container.db)).toEqual([]);
  });
});
