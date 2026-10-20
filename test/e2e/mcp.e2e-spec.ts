import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { onboardTenant } from './support/onboard.js';

type ToolResult = {
  isError?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: Record<string, any>;
  content: { type: string; text?: string }[];
};

describe('MCP (AI-first)', () => {
  let ctx: E2EApp;
  let client: Client;

  const connect = async (apiKey: string) => {
    const c = new Client({ name: 'e2e-agent', version: '1.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      })
    );
    return c;
  };
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  beforeAll(async () => {
    ctx = await startE2EApp();
    const { apiKey } = await onboardTenant(ctx);
    client = await connect(apiKey);
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await ctx?.close();
  });

  it('expõe as ferramentas de emissão com instruções', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_company',
        'get_certificate_status',
        'search_service_codes',
        'get_municipal_rate',
        'create_product',
        'update_product',
        'list_products',
        'issue_invoice',
        'list_invoices',
        'get_invoice',
        'explain_invoice',
        'retry_invoice',
        'cancel_invoice',
        'resend_invoice',
      ])
    );
    expect(tools.find((t) => t.name === 'cancel_invoice')!.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/açaínfe/);
  });

  it('agente cadastra produto, emite e consulta a nota', async () => {
    const company = await call('get_company');
    expect(company.structuredContent!.cnpj).toBe('11222333000181');
    expect((await call('get_certificate_status')).structuredContent!.present).toBe(true);

    const codes = await call('search_service_codes', { query: 'desenvolvimento de sistemas' });
    const code = codes.structuredContent!.codes[0].nationalServiceCode;
    expect(code).toBe('010101');
    const rate = await call('get_municipal_rate', { nationalServiceCode: code });
    expect(rate.structuredContent!.issRateBps).toBe(200);

    const product = await call('create_product', {
      name: 'Desenvolvimento de app',
      externalId: 'dev-app',
      taxProfile: { nationalServiceCode: code },
    });
    expect(product.isError).toBeFalsy();
    // Sem NBS a venda fica bloqueada; a busca traz as opções oficiais para o agente sugerir.
    expect(product.structuredContent!.warnings[0]).toMatch(/NBS/);
    const nbsOptions: string[] = codes.structuredContent!.codes[0].nbsOptions;
    expect(nbsOptions).toContain('115021000');
    const blocked = await call('issue_invoice', {
      externalId: 'mcp-0',
      items: [{ productExternalId: 'dev-app', totalCents: 1000 }],
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/sem código NBS/);
    const fixed = await call('update_product', {
      id: product.structuredContent!.id,
      taxProfile: { nbsCode: '115021000' },
    });
    expect(fixed.structuredContent!.warnings).toEqual([]);

    const issued = await call('issue_invoice', {
      externalId: 'mcp-1',
      customer: { name: 'Cliente IA', taxId: '52998224725', email: 'ia@cliente.com' },
      items: [{ productExternalId: 'dev-app', totalCents: 250000 }],
    });
    const invoiceId = issued.structuredContent!.invoices[0].id;
    expect(issued.structuredContent!.note).toMatch(/assíncrona/);

    const final = await eventually(
      async () => (await call('get_invoice', { id: invoiceId })).structuredContent!,
      (inv) => inv.status === 'ISSUED'
    );
    expect(final.nfse.accessKey).toHaveLength(50);

    const list = await call('list_invoices', { status: ['ISSUED'] });
    expect(list.structuredContent!.total).toBeGreaterThanOrEqual(1);
  });

  it('erros de domínio voltam como isError legível para o agente', async () => {
    const res = await call('issue_invoice', {
      externalId: 'mcp-2',
      items: [{ productExternalId: 'inexistente', totalCents: 1 }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Produto não cadastrado/);
    const bad = await call('get_invoice', { id: 'nao-existe' });
    expect(bad.isError).toBe(true);
  });

  it('recusa conexão sem API key válida', async () => {
    await expect(connect('chave-invalida')).rejects.toThrow();
  });
});
