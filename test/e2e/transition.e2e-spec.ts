import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

/** Hoje em Brasília (AAAA-MM-DD): a virada é hoje, então vendas de hoje já vão para o nacional. */
const todayBrt = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);

describe('Virada do Simples para o Emissor Nacional (São Bernardo, Ginfes → nacional)', () => {
  let ctx: E2EApp;
  let apiKey: string;
  let client: Client;
  const http = () => request(ctx.baseUrl);
  const getInvoice = (id: string) =>
    http()
      .get(`/v1/invoices/${id}`)
      .set('x-api-key', apiKey)
      .then((r) => r.body);
  const sale = async (externalId: string, competenceDate?: string) => {
    const res = await http()
      .post('/v1/sales')
      .set('x-api-key', apiKey)
      .send({
        externalId,
        competenceDate,
        customer: { name: 'Ana Souza', taxId: '52998224725' },
        items: [{ productExternalId: 'curso', totalCents: 9700 }],
      })
      .expect(202);
    return res.body.invoices[0].id as string;
  };

  beforeAll(async () => {
    ctx = await startE2EApp({
      GINFES_CITIES: '3548708',
      GINFES_PILOT: 'false',
      MUNICIPAL_SYSTEMS_CUTOVER: todayBrt,
      NACIONAL_PILOT_NOTES: '1',
    });
    ({ apiKey } = await onboardTenant(ctx));
    await http()
      .post('/v1/products')
      .set('x-api-key', apiKey)
      .send({
        name: 'Curso',
        externalId: 'curso',
        taxProfile: {
          nationalServiceCode: '080201',
          nbsCode: '122051900',
          localServiceCode: '8.02/103911/1551',
          issRateBps: 201,
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

  let ginfesInvoiceId: string;

  it('venda com competência antes da virada continua no sistema da prefeitura (retroativa)', async () => {
    ginfesInvoiceId = await sale('venda-outubro', '2026-01-15');
    const issued = await eventually(
      () => getInvoice(ginfesInvoiceId),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse.provider).toBe('GINFES');
    expect(ctx.sefin.dpsXmls).toHaveLength(0);
  });

  it('a partir da virada: nacional, com aprovação na primeira nota e espera se a prefeitura não liberou (E0039)', async () => {
    ctx.sefin.mode = 'E0039';
    const id = await sale('venda-novembro');
    const waiting = await eventually(
      () => getInvoice(id),
      (b) => b.lastErrors?.[0]?.code === 'AWAITING_APPROVAL'
    );
    expect(waiting.lastErrors[0].message).toMatch(/Primeiras notas pelo Emissor Nacional/);

    const approved = (await client.callTool({
      name: 'approve_invoice',
      arguments: { id },
    })) as ToolResult;
    expect(approved.isError).toBeFalsy();
    const parked = await eventually(
      () => getInvoice(id),
      (b) => b.lastErrors?.[0]?.code === 'AWAITING_MUNICIPALITY'
    );
    expect(parked).toMatchObject({ status: 'RETRYING', attempts: 0 });
    expect(new Date(parked.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    expect(parked.hints.join(' ')).toMatch(/tenta de novo a cada hora/);
    expect(parked.hints.join(' ')).not.toMatch(/regime tributário/);

    // A prefeitura libera: o reprocessamento (ou a tentativa automática da hora) sai pelo nacional.
    ctx.sefin.mode = 'OK';
    const retried = (await client.callTool({
      name: 'retry_invoice',
      arguments: { id },
    })) as ToolResult;
    expect(retried.isError).toBeFalsy();
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse.provider).toBe('NACIONAL');
  });

  it('depois da primeira nota aprovada, as seguintes saem sozinhas pelo nacional', async () => {
    const id = await sale('venda-novembro-2');
    const issued = await eventually(
      () => getInvoice(id),
      (b) => b.status === 'ISSUED'
    );
    expect(issued.nfse.provider).toBe('NACIONAL');
  });

  it('nota antiga do Ginfes continua sendo cancelada no Ginfes', async () => {
    await http()
      .post(`/v1/invoices/${ginfesInvoiceId}/cancel`)
      .set('x-api-key', apiKey)
      .send({ reasonCode: '2', reason: 'Serviço não prestado ao cliente' })
      .expect(201);
    await eventually(
      () => getInvoice(ginfesInvoiceId),
      (b) => b.status === 'CANCELLED'
    );
    expect(ctx.ginfes.nfses[0].cancelled).toBe(true);
    expect(ctx.sefin.events).toHaveLength(0);
  });
});
