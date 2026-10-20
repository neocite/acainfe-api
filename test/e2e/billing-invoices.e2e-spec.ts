import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodRange, previousPeriod } from '../../src/domain/accounting/accountant-report.js';
import { ADMIN_KEY, E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

const ISSUER_CNPJ = '11222333000181';
const CLIENT_CNPJ = '11444777000161';

describe('Nota mensal do uso do açaínfe (operadora → cliente)', () => {
  let ctx: E2EApp;
  let issuerKey: string;
  let issuerId: string;
  let clientId: string;
  const http = () => request(ctx.baseUrl);
  const period = previousPeriod(new Date());
  const charge = (tenantId: string, createdAt: Date, amountCents = 80) =>
    ctx.container.db.collection('billing_charges').insertOne({
      _id: randomUUID(),
      tenantId,
      invoiceId: `inv-${randomUUID()}`,
      amountCents,
      status: 'OPEN',
      createdAt,
    } as never);

  beforeAll(async () => {
    ctx = await startE2EApp({
      BILLING_INVOICE_ISSUER_CNPJ: ISSUER_CNPJ,
      BILLING_INVOICE_PRODUCT_EXTERNAL_ID: 'acainfe-uso',
    });
    ({ apiKey: issuerKey, tenantId: issuerId } = await onboardTenant(ctx, ISSUER_CNPJ));
    ({ tenantId: clientId } = await onboardTenant(ctx, CLIENT_CNPJ));
    await http()
      .post('/v1/products')
      .set('x-api-key', issuerKey)
      .send({
        name: 'Prestação de serviço açaí nfe',
        externalId: 'acainfe-uso',
        taxProfile: { nationalServiceCode: '010501', nbsCode: '111032900' },
      })
      .expect(201);
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('soma as cobranças do mês fechado e emite uma nota da operadora para o cliente', async () => {
    const { from, to } = periodRange(period);
    await charge(clientId, from);
    await charge(clientId, new Date(to.getTime() - 60_000));
    await charge(clientId, to); // já é o mês corrente
    await charge(issuerId, from); // a operadora não fatura a si mesma

    const res = await http()
      .post(`/v1/admin/billing/monthly-invoices/${period}`)
      .set('x-admin-key', ADMIN_KEY)
      .expect(201);
    expect(res.body).toEqual({
      period,
      registered: 1,
      alreadyRegistered: 0,
      held: 0,
      failed: [],
    });

    const issued = await eventually(
      () =>
        http()
          .get('/v1/invoices?status=ISSUED')
          .set('x-api-key', issuerKey)
          .then((r) => r.body.items as Record<string, any>[]), // eslint-disable-line @typescript-eslint/no-explicit-any
      (items) => items.length === 1
    );
    expect(issued[0]).toMatchObject({
      amountCents: 160,
      customer: expect.objectContaining({ name: 'Empresa E2E LTDA' }),
    });
    expect(issued[0].serviceDescription).toContain('2 nota(s) emitida(s)');

    const again = await http()
      .post(`/v1/admin/billing/monthly-invoices/${period}`)
      .set('x-admin-key', ADMIN_KEY)
      .expect(201);
    expect(again.body).toMatchObject({ registered: 0, alreadyRegistered: 1 });
  });

  it('recusa o mês em andamento e exige a chave de admin', async () => {
    const current = new Date().toISOString().slice(0, 7);
    await http()
      .post(`/v1/admin/billing/monthly-invoices/${current}`)
      .set('x-admin-key', ADMIN_KEY)
      .expect(422);
    await http().post(`/v1/admin/billing/monthly-invoices/${period}`).expect(401);
  });
});
