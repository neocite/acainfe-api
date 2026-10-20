import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTestPfx } from '../support/test-certificate.js';
import { validateAgainstXsd } from '../support/xsd.js';
import { findNonIntegerNumbers } from './support/integer-guard.js';
import { ADMIN_KEY, E2EApp, eventually, startE2EApp } from './support/e2e-app.js';

describe('Fluxo completo de emissão (REST + fila + Sefin fake)', () => {
  let ctx: E2EApp;
  let apiKey: string;
  let tenantId: string;
  const http = () => request(ctx.baseUrl);
  const auth = { 'x-api-key': '' };

  beforeAll(async () => {
    ctx = await startE2EApp();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('health', async () => {
    await http().get('/health').expect(200, { status: 'ok' });
  });

  it('cadastra empresa (somente admin) e devolve API key', async () => {
    const payload = {
      cnpj: '11.222.333/0001-81',
      legalName: 'Empresa Teste LTDA',
      municipalRegistration: '123456',
      taxRegime: 'SIMPLES_NACIONAL',
      simplesNacionalTaxRateBps: 600,
      email: 'financeiro@empresa.com.br',
      businessType: 'INFOPRODUCER',
    };
    await http().post('/v1/tenants').send(payload).expect(401);
    const res = await http()
      .post('/v1/tenants')
      .set('x-admin-key', ADMIN_KEY)
      .send(payload)
      .expect(201);
    apiKey = res.body.apiKey;
    tenantId = res.body.tenant.id;
    auth['x-api-key'] = apiKey;
    expect(res.body.tenant).toMatchObject({
      cnpj: '11222333000181',
      cityCode: '3548708',
      environment: 'HOMOLOGATION',
    });
    expect(res.body.tenant).not.toHaveProperty('apiKeyHashes');

    await http().post('/v1/tenants').set('x-admin-key', ADMIN_KEY).send(payload).expect(409);
    await http()
      .post('/v1/tenants')
      .set('x-admin-key', ADMIN_KEY)
      .send({ ...payload, cnpj: '123' })
      .expect(422);
    await http().get('/v1/tenants/me').expect(401);
    const me = await http()
      .get('/v1/tenants/me')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);
    expect(me.body.id).toBe(tenantId);
  });

  it('recebe o certificado A1 por multipart e valida senha', async () => {
    const { pfx, password } = generateTestPfx();
    await http()
      .post('/v1/certificates')
      .set(auth)
      .attach('file', pfx, 'cert.pfx')
      .field('password', 'errada')
      .expect(422);
    const res = await http()
      .post('/v1/certificates')
      .set(auth)
      .field('password', password)
      .attach('file', pfx, 'cert.pfx')
      .expect(201);
    expect(res.body).toMatchObject({
      present: true,
      expired: false,
      metadata: { cnpj: '11222333000181' },
    });
    const stored = await ctx.container.db.collection('certificates').findOne({ tenantId });
    expect(JSON.stringify(stored)).not.toContain(password);
    await http().get('/v1/certificates/current').set(auth).expect(200);
  });

  it('cadastra produtos com códigos de serviço diferentes', async () => {
    await http()
      .post('/v1/products')
      .set(auth)
      .send({ name: 'Sem código', taxProfile: {} })
      .expect(422);
    const suporte = await http()
      .post('/v1/products')
      .set(auth)
      .send({
        name: 'Suporte técnico',
        externalId: 'sup',
        serviceDescription: 'Suporte técnico mensal',
        taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
      })
      .expect(201);
    expect(suporte.body.taxProfile.nationalServiceCode).toBe('010701');
    await http()
      .post('/v1/products')
      .set(auth)
      .send({
        name: 'Treinamento',
        externalId: 'curso',
        taxProfile: { nationalServiceCode: '080201' },
      })
      .expect(201);
    await http()
      .post('/v1/products')
      .set(auth)
      .send({ name: 'Dup', externalId: 'curso', taxProfile: { nationalServiceCode: '080201' } })
      .expect(409);

    const list = await http().get('/v1/products?search=supor').set(auth).expect(200);
    expect(list.body.total).toBe(1);
    const patched = await http()
      .patch(`/v1/products/${suporte.body.id}`)
      .set(auth)
      .send({ defaultPriceCents: 10000 })
      .expect(200);
    expect(patched.body.defaultPriceCents).toBe(10000);

    const codes = await http().get('/v1/service-codes?q=treinamento').set(auth).expect(200);
    expect(codes.body[0].nationalServiceCode).toBe('080201');
    const params = await http().get('/v1/municipal-params/010701').set(auth).expect(200);
    expect(params.body.issRateBps).toBe(200);
  });

  it('venda com 2 códigos → 2 NFS-e emitidas e enviadas por e-mail e WhatsApp', async () => {
    const sale = {
      externalId: 'pedido-1001',
      customer: {
        taxId: '529.982.247-25',
        name: 'Maria da Silva',
        email: 'maria@example.com',
        phone: '(11) 99999-8888',
      },
      items: [
        { productExternalId: 'sup', unitPriceCents: 15000, quantity: 1 },
        {
          productExternalId: 'curso',
          totalCents: 50000,
          description: 'Treinamento de Excel — turma outubro',
        },
      ],
    };
    const res = await http().post('/v1/sales').set(auth).send(sale).expect(202);
    expect(res.body.invoices).toHaveLength(2);
    expect(res.body.invoices.every((i: { status: string }) => i.status === 'PENDING')).toBe(true);

    const issued = await eventually(
      () =>
        http()
          .get(`/v1/invoices?saleId=${res.body.sale.id}`)
          .set(auth)
          .then((r) => r.body),
      (b) => b.items.length === 2 && b.items.every((i: { status: string }) => i.status === 'ISSUED')
    );
    expect(issued.items.map((i: { nfse: { pdfUrl: string } }) => i.nfse.pdfUrl)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('https://api.acainfe.test/v1/public/invoices/'),
      ])
    );

    // Os DPS enviados estão assinados e válidos no XSD oficial.
    expect(ctx.sefin.dpsXmls).toHaveLength(2);
    for (const xml of ctx.sefin.dpsXmls)
      expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
    expect(ctx.sefin.dpsXmls.some((x) => x.includes('<cTribNac>080201</cTribNac>'))).toBe(true);

    await eventually(
      async () => ({ e: ctx.email.sent.length, w: ctx.whatsapp.sent.length }),
      (v) => v.e === 2 && v.w === 2
    );
    expect(ctx.email.sent[0]).toMatchObject({
      to: 'maria@example.com',
      attachments: [{ contentType: 'application/pdf' }],
    });
    expect(ctx.whatsapp.sent[0].phone).toBe('5511999998888');
    expect(ctx.whatsapp.sent[0].fileUrl).toMatch(/\/pdf\?sig=/);

    const delivered = await eventually(
      () =>
        http()
          .get(`/v1/invoices/${issued.items[0].id}`)
          .set(auth)
          .then((r) => r.body),
      (b) => b.deliveries.every((d: { status: string }) => d.status === 'SENT')
    );
    expect(delivered.deliveries).toHaveLength(2);
  });

  it('idempotência: reenviar a mesma venda não duplica notas', async () => {
    const res = await http()
      .post('/v1/sales')
      .set(auth)
      .send({ externalId: 'pedido-1001', items: [{ productExternalId: 'sup', totalCents: 1 }] })
      .expect(202);
    expect(res.body.duplicated).toBe(true);
    expect(res.body.invoices).toHaveLength(2);
    expect(await ctx.container.db.collection('invoices').countDocuments()).toBe(2);
  });

  it('PDF, XML e link público assinado', async () => {
    const list = await http().get('/v1/invoices?status=ISSUED').set(auth).expect(200);
    const id = list.body.items[0].id;
    const pdf = await http()
      .get(`/v1/invoices/${id}/pdf`)
      .set(auth)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const xml = await http().get(`/v1/invoices/${id}/xml`).set(auth).expect(200);
    expect(xml.text).toContain('<infNFSe Id="NFS');

    const publicUrl = new URL(list.body.items[0].nfse.pdfUrl);
    await http().get(`${publicUrl.pathname}${publicUrl.search}`).expect(200);
    await http().get(`/v1/public/invoices/${id}/pdf?sig=forjada`).expect(404);
  });

  it('isolamento entre empresas', async () => {
    const other = await http()
      .post('/v1/tenants')
      .set('x-admin-key', ADMIN_KEY)
      .send({
        cnpj: '11444777000161',
        legalName: 'Outra',
        municipalRegistration: '9',
        taxRegime: 'MEI',
        email: 'o@o.com',
      })
      .expect(201);
    const list = await http().get('/v1/invoices').set('x-api-key', other.body.apiKey).expect(200);
    expect(list.body.total).toBe(0);
    const mine = await http().get('/v1/invoices').set(auth).expect(200);
    await http()
      .get(`/v1/invoices/${mine.body.items[0].id}`)
      .set('x-api-key', other.body.apiKey)
      .expect(404);
  });

  it('cancela nota emitida enviando o evento 101101', async () => {
    const list = await http().get('/v1/invoices?status=ISSUED').set(auth).expect(200);
    const id = list.body.items[0].id;
    await http()
      .post(`/v1/invoices/${id}/cancel`)
      .set(auth)
      .send({ reasonCode: '1', reason: 'curta' })
      .expect(422);
    const res = await http()
      .post(`/v1/invoices/${id}/cancel`)
      .set(auth)
      .send({ reasonCode: '1', reason: 'Valor do serviço informado errado' })
      .expect(201);
    expect(res.body.status).toBe('CANCELLED');
    expect(ctx.sefin.events[0]).toContain('<cMotivo>1</cMotivo>');
    expect(await validateAgainstXsd(ctx.sefin.events[0], 'pedRegEvento_v1.01.xsd')).toEqual([]);
    await http()
      .post(`/v1/invoices/${id}/cancel`)
      .set(auth)
      .send({ reasonCode: '1', reason: 'Valor do serviço informado errado' })
      .expect(409);
  });
  it('todos os valores numéricos persistidos são inteiros (centavos, pontos-base)', async () => {
    expect(await findNonIntegerNumbers(ctx.container.db)).toEqual([]);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
