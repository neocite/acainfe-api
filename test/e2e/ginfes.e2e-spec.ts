import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_KEY, E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

type ToolResult = {
  isError?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: Record<string, any>;
  content: { type: string; text?: string }[];
};

describe('Ginfes (São Bernardo do Campo) com modo piloto', () => {
  let ctx: E2EApp;
  let apiKey: string;
  let tenantId: string;
  let client: Client;
  const http = () => request(ctx.baseUrl);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const getInvoice = (id: string) =>
    http()
      .get(`/v1/invoices/${id}`)
      .set('x-api-key', apiKey)
      .then((r) => r.body);
  const sale = async (externalId: string, customer: Record<string, unknown>) => {
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({ externalId, customer, items: [{ productExternalId: 'jely', totalCents: 3500 }] })
      .expect(202);
    return res.body.invoices[0].id as string;
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    ({ apiKey, tenantId } = await onboardTenant(ctx));
    // A própria empresa não escolhe o sistema de emissão (campo ignorado)…
    await http()
      .patch('/v1/tenants/me')
      .set('x-api-key', apiKey)
      .send({ fiscalProvider: 'GINFES', environment: 'HOMOLOGATION' })
      .expect(200);
    const me = await http().get('/v1/tenants/me').set('x-api-key', apiKey).expect(200);
    expect(me.body).toMatchObject({ environment: 'PRODUCTION' });
    expect(me.body.fiscalProvider).toBeUndefined();
    // …só o admin: empresa de SBC passa a emitir pelo Ginfes.
    await http()
      .patch(`/v1/admin/tenants/${tenantId}`)
      .set('x-admin-key', ADMIN_KEY)
      .send({ fiscalProvider: 'GINFES' })
      .expect(200);
    // Produto com o perfil de infoprodutor (código local 8.02/103911/1551).
    await http()
      .post('/v1/products')
      .set('x-api-key', apiKey)
      .send({ name: 'Venda espaço Jely', externalId: 'jely' })
      .expect(201);
    client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      })
    );
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await ctx?.close();
  });

  it('nota espera aprovação; com a prévia conferida, emite pelo Ginfes', async () => {
    const id = await sale('pix_jely_1', {
      name: 'Bruno Lima',
      address: {
        street: 'R. Luiz Pereira Barreto',
        number: '1248',
        district: 'Centro',
        cityCode: '3502804',
        zipCode: '16015445',
      },
    });
    const waiting = await eventually(
      () => getInvoice(id),
      (b) => b.lastErrors?.[0]?.code === 'AWAITING_APPROVAL'
    );
    expect(waiting.status).toBe('PENDING');
    expect(ctx.ginfes.received).toEqual([]);

    const preview = await call('preview_invoice', { id });
    expect(preview.structuredContent).toMatchObject({ provider: 'GINFES' });
    expect(preview.structuredContent!.xml).toContain(
      '<tipos:CodigoTributacaoMunicipio>8.02/103911/1551</tipos:CodigoTributacaoMunicipio>'
    );
    expect(preview.structuredContent!.xml).toContain('<tipos:Aliquota>0.0201</tipos:Aliquota>');

    expect((await call('approve_invoice', { id })).isError).toBeFalsy();
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse).toMatchObject({ provider: 'GINFES', number: '1001', accessKey: 'VER1X' });
    expect(issued.nfse.verificationUrl).toContain('visualizar.isssbc.com.br');
    expect(ctx.ginfes.received.map((r) => r.operation)).toEqual(
      expect.arrayContaining([
        'RecepcionarLoteRpsV3',
        'ConsultarSituacaoLoteRpsV3',
        'ConsultarLoteRpsV3',
      ])
    );
    expect(ctx.ginfes.received[0].args[0]).toContain('<versaoDados>3</versaoDados>');

    const pdf = await http()
      .get(`/v1/invoices/${id}/pdf`)
      .set('x-api-key', apiKey)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    const one = await call('get_municipal_invoice', { number: '1001' });
    expect(one.structuredContent).toMatchObject({
      number: '1001',
      verificationCode: 'VER1X',
      details: { aliquota: '0.0201' },
    });
    expect((await call('get_municipal_invoice', { number: '999999' })).isError).toBe(true);

    const municipal = await call('list_municipal_invoices', {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(municipal.structuredContent!.items).toEqual([
      expect.objectContaining({
        number: '1001',
        amountCents: 3500,
        customerName: 'Bruno Lima',
      }),
    ]);
  });

  it('rejeição da prefeitura aparece com o código; cancelamento funciona', async () => {
    ctx.ginfes.rejectNext = { code: 'E35', message: 'Código de tributação inexistente' };
    const rejectedId = await sale('pix_jely_2', { name: 'Fulano', taxId: '52998224725' });
    await eventually(
      () => getInvoice(rejectedId),
      (b) => b.lastErrors?.[0]?.code === 'AWAITING_APPROVAL'
    );
    await call('approve_invoice', { id: rejectedId });
    const rejected = await eventually(
      () => getInvoice(rejectedId),
      (b) => b.status === 'REJECTED'
    );
    expect(rejected.lastErrors[0]).toMatchObject({ code: 'E35' });

    const issued = (
      await http().get('/v1/invoices?status=ISSUED').set('x-api-key', apiKey).expect(200)
    ).body.items[0];
    await http()
      .post(`/v1/invoices/${issued.id}/cancel`)
      .set('x-api-key', apiKey)
      .send({ reasonCode: '2', reason: 'Serviço não prestado ao cliente' })
      .expect(201);
    await eventually(
      () => getInvoice(issued.id),
      (b) => b.status === 'CANCELLED'
    );
    expect(ctx.ginfes.nfses[0].cancelled).toBe(true);
  });

  it('cruza as vendas do AbacatePay com as notas do eNotas e emite só o que falta', async () => {
    const today = new Date().toISOString();
    ctx.external.products = [{ id: 'jely', name: 'Venda espaço Jely', price: 3500, cycle: null }];
    ctx.external.customers = [
      { id: 'cust_a', name: 'Ana Souza', email: 'ana@x.com', taxId: '529.982.247-25' },
    ];
    const checkout = (id: string, customerId?: string) => ({
      id,
      status: 'PAID',
      amount: 3500,
      paidAmount: 3500,
      items: [{ id: 'jely', quantity: 1 }],
      customerId,
      createdAt: today,
      updatedAt: today,
    });
    ctx.external.history.checkouts = [checkout('bill_ana', 'cust_a'), checkout('bill_sem_nota')];
    // A venda da Ana já teve nota emitida pelo eNotas.
    ctx.ginfes.seedExternal({ number: '48600', amount: '35.00', cpf: '52998224725', rps: '700' });

    const connected = await call('connect_abacatepay', {
      apiKey: ctx.external.validKey,
      monthsBack: 0,
    });
    const period = connected.structuredContent!.pastSales.periods[0].period;
    expect(connected.structuredContent!.pastSales.periods[0].available.count).toBe(2);

    const blocked = await call('issue_past_sales', { period });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/reconcile_past_sales/);

    const reconciled = await call('reconcile_past_sales', { period });
    expect(reconciled.structuredContent!.matches).toEqual([
      expect.objectContaining({
        externalId: 'bill_ana',
        confidence: 'HIGH',
        nfse: expect.objectContaining({ number: '48600' }),
      }),
    ]);
    // A nota 1001 foi emitida pelo açaínfe (e cancelada): não conta como "outro sistema".
    expect(reconciled.structuredContent!.unmatched).toEqual([
      expect.objectContaining({ externalId: 'bill_sem_nota' }),
    ]);

    const applied = await call('apply_past_sales_reconciliation', { period, confidence: 'HIGH' });
    expect(applied.structuredContent).toEqual({ marked: 1, remainingAvailable: 1 });

    const issued = await call('issue_past_sales', { period });
    expect(issued.structuredContent).toMatchObject({ issued: 1, failed: [] });
    const pending = await eventually(
      () =>
        http()
          .get('/v1/invoices?status=PENDING')
          .set('x-api-key', apiKey)
          .then((r) => r.body.items as { lastErrors?: { code: string }[] }[]),
      (items) => items.some((i) => i.lastErrors?.[0]?.code === 'AWAITING_APPROVAL')
    );
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('a flag volta a empresa para o Emissor Nacional', async () => {
    await http()
      .patch(`/v1/admin/tenants/${tenantId}`)
      .set('x-admin-key', ADMIN_KEY)
      .send({ fiscalProvider: 'NACIONAL' })
      .expect(200);
    const id = await sale('pix_jely_3', { name: 'Beltrano', taxId: '52998224725' });
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse.provider).toBe('NACIONAL');
    expect(issued.nfse.accessKey).toMatch(/^\d{50}$/);
  });
});
