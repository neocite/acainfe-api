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

describe('NFS-e Paulistana (São Paulo) com modo piloto', () => {
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
      .send({ externalId, customer, items: [{ productExternalId: 'mentoria', totalCents: 9700 }] })
      .expect(202);
    return res.body.invoices[0].id as string;
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    ({ apiKey, tenantId } = await onboardTenant(ctx));
    await http()
      .patch(`/v1/admin/tenants/${tenantId}`)
      .set('x-admin-key', ADMIN_KEY)
      .send({ fiscalProvider: 'PAULISTANA' })
      .expect(200);
    // Código de serviço de SP (5 dígitos): 05762, cursos e treinamentos (item 8.02).
    await http()
      .post('/v1/products')
      .set('x-api-key', apiKey)
      .send({
        name: 'Mentoria em grupo',
        externalId: 'mentoria',
        taxProfile: {
          nationalServiceCode: '080201',
          nbsCode: '122051900',
          localServiceCode: '05762',
          issRateBps: 500,
        },
      })
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

  it('nota espera aprovação; aprovada, sai na hora pela prefeitura de SP', async () => {
    const id = await sale('pix_sp_1', {
      name: 'Ana Souza',
      taxId: '52998224725',
      email: 'ana@exemplo.com',
      address: {
        street: 'Av. Paulista',
        number: '100',
        district: 'Bela Vista',
        cityCode: '3550308',
        zipCode: '01310100',
      },
    });
    await eventually(
      () => getInvoice(id),
      (b) => b.lastErrors?.[0]?.code === 'AWAITING_APPROVAL'
    );
    expect(ctx.paulistana.received).toEqual([]);

    const company = await call('get_company');
    expect(company.structuredContent!.emission).toMatchObject({
      system: 'PAULISTANA',
      approvalRequired: true,
    });

    const preview = await call('preview_invoice', { id });
    expect(preview.structuredContent).toMatchObject({ provider: 'PAULISTANA' });
    expect(preview.structuredContent!.xml).toContain('<CodigoServico>05762</CodigoServico>');

    expect((await call('approve_invoice', { id })).isError).toBeFalsy();
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse).toMatchObject({
      provider: 'PAULISTANA',
      number: '9001',
      accessKey: 'SPV00001',
    });
    expect(issued.nfse.verificationUrl).toContain(
      'nfe.prefeitura.sp.gov.br/contribuinte/notaprint.aspx'
    );
    expect(ctx.paulistana.received.map((r) => r.operation)).toEqual(['EnvioRPS', 'ConsultaNFe']);
    expect(ctx.paulistana.received[0].soapAction).toBe(
      '"http://www.prefeitura.sp.gov.br/nfe/ws/envioRPS"'
    );

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

    const one = await call('get_municipal_invoice', { number: '9001' });
    expect(one.structuredContent).toMatchObject({ number: '9001', amountCents: 9700 });
    // Data de Brasília (a nota é do dia local; em UTC pode já ser o dia seguinte).
    const today = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
    const municipal = await call('list_municipal_invoices', { from: today, to: today });
    expect(municipal.structuredContent!.items).toEqual([
      expect.objectContaining({ number: '9001', customerName: 'Ana Souza', issuedByAcainfe: true }),
    ]);
  });

  it('rejeição da prefeitura aparece com o código; cancelamento funciona', async () => {
    ctx.paulistana.rejectNext = { code: '306', message: 'Código de serviço inexistente' };
    const rejectedId = await sale('pix_sp_2', { name: 'Fulano', taxId: '52998224725' });
    await eventually(
      () => getInvoice(rejectedId),
      (b) => b.lastErrors?.[0]?.code === 'AWAITING_APPROVAL'
    );
    await call('approve_invoice', { id: rejectedId });
    const rejected = await eventually(
      () => getInvoice(rejectedId),
      (b) => b.status === 'REJECTED'
    );
    expect(rejected.lastErrors[0]).toMatchObject({ code: '306' });
    const explained = await call('explain_invoice', { id: rejectedId });
    expect(JSON.stringify(explained.structuredContent)).toMatch(/05762/);

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
    expect(ctx.paulistana.nfes[0].cancelled).toBe(true);
  });
});
