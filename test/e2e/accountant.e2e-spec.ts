import { unzipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../../src/adapters/out/mongo/mongo-repositories.js';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

const currentPeriod = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 7);

describe('Envio mensal ao contador e índices do banco', () => {
  let ctx: E2EApp;
  let apiKey: string;
  let tenantId: string;
  const http = () => request(ctx.baseUrl);

  beforeAll(async () => {
    ctx = await startE2EApp();
    ({ apiKey, tenantId } = await onboardTenant(ctx));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('índices únicos críticos existem no MongoDB', async () => {
    const unique = async (collection: string) =>
      (await ctx.container.db.collection(collection).indexes())
        .filter((i) => i.unique)
        .map((i) => Object.keys(i.key).join(','));
    expect(await unique('billing_charges')).toContain('invoiceId');
    expect(await unique('users')).toContain('externalId');
    expect(await unique('customers')).toEqual(
      expect.arrayContaining(['tenantId,taxId.value', 'tenantId,externalId'])
    );
    expect(await unique('accountant_reports')).toContain('tenantId,period');
    expect(await unique('sales')).toContain('tenantId,source,externalId,environment');
  });

  it('migração: vendas e notas antigas recebem o ambiente da empresa; índice antigo é removido', async () => {
    const db = ctx.container.db;
    await db.collection('sales').dropIndex('sale_external_id_per_environment');
    await db
      .collection('sales')
      .createIndex({ tenantId: 1, source: 1, externalId: 1 }, { unique: true });
    await db
      .collection('sales')
      .insertOne({ _id: 'legacy' as never, tenantId, source: 'API', externalId: 'old' });
    await ensureIndexes(db);
    expect(await db.collection('sales').findOne({ _id: 'legacy' as never })).toMatchObject({
      environment: 'PRODUCTION',
    });
    const names = (await db.collection('sales').indexes()).map((i) => i.name);
    expect(names).not.toContain('tenantId_1_source_1_externalId_1');
    expect(names).toContain('sale_external_id_per_environment');
    await db.collection('sales').deleteOne({ _id: 'legacy' as never });
  });

  it('cadastra o contador, envia o pacote do mês e o contador baixa pelo link', async () => {
    for (const [externalId, total] of [
      ['ct-1', 19700],
      ['ct-2', 9700],
    ] as const) {
      const res = await http()
        .post('/v1/sales')
        .set('x-api-key', apiKey)
        .send({
          externalId,
          customer: { taxId: '52998224725', name: 'Maria' },
          items: [{ productExternalId: 'prod_suporte', totalCents: total }],
        })
        .expect(202);
      await eventually(
        () =>
          http()
            .get(`/v1/invoices/${res.body.invoices[0].id}`)
            .set('x-api-key', apiKey)
            .then((r) => r.body),
        (b) => b.status === 'ISSUED'
      );
    }

    await http().put('/v1/tenants/me/accountant').set('x-api-key', apiKey).send({}).expect(422);
    const acc = await http()
      .put('/v1/tenants/me/accountant')
      .set('x-api-key', apiKey)
      .send({ name: 'Contábil SA', email: 'contador@contabil.com', whatsapp: '11977776666' })
      .expect(200);
    expect(acc.body).toMatchObject({
      email: 'contador@contabil.com',
      whatsapp: '5511977776666',
      monthlyReport: true,
      dayOfMonth: 1,
    });

    const period = currentPeriod();
    const report = await http()
      .post('/v1/tenants/me/accountant/reports')
      .set('x-api-key', apiKey)
      .send({ period })
      .expect(201);
    expect(report.body).toMatchObject({
      status: 'SENT',
      invoiceCount: 2,
      totalCents: 29400,
      channels: ['EMAIL', 'WHATSAPP'],
    });

    const mail = ctx.email.sent.find((m) => m.to === 'contador@contabil.com')!;
    const csv = mail.attachments.find((a) => a.filename.endsWith('.csv'))!.content.toString('utf8');
    expect(csv).toContain('Cliente_NomeRazaoSocial;Cliente_NomeFantasia;Cliente_Documento');
    expect(csv).toContain('Maria;;529.982.247-25');
    const wa = ctx.whatsapp.sent.find((m) => m.phone === '5511977776666')!;
    const link = new URL(wa.fileUrl!);
    expect(link.pathname).toBe(`/v1/public/accountant-packages/${tenantId}/${period}`);

    const zip = await http()
      .get(`${link.pathname}${link.search}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const files = Object.keys(unzipSync(new Uint8Array(zip.body as Buffer)));
    expect(files.filter((f) => f.startsWith('pdf/'))).toHaveLength(2);
    expect(files.filter((f) => f.startsWith('xml/'))).toHaveLength(2);
    await http()
      .get(`/v1/public/accountant-packages/${tenantId}/${period}?sig=forjada`)
      .expect(404);

    const history = await http()
      .get('/v1/tenants/me/accountant/reports')
      .set('x-api-key', apiKey)
      .expect(200);
    expect(history.body[0]).toMatchObject({ period, trigger: 'MANUAL' });
  });
});
