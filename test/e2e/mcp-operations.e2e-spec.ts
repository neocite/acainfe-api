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

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('MCP: operação completa da empresa', () => {
  let ctx: E2EApp;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  beforeAll(async () => {
    ctx = await startE2EApp();
    const { apiKey } = await onboardTenant(ctx);
    client = new Client({ name: 'e2e-agent', version: '1.0.0' });
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

  it('expõe ferramentas para todas as operações e prompts de onboarding', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'update_company',
        'set_company_logo',
        'remove_company_logo',
        'enable_abacatepay_integration',
        'connect_abacatepay',
        'create_certificate_upload_link',
        'upload_certificate',
        'get_product',
        'deactivate_product',
        'create_customer',
        'list_customers',
        'get_customer',
        'update_customer',
        'delete_customer',
        'get_sale',
        'refund_sale',
      ])
    );
    expect(names.length).toBeGreaterThanOrEqual(29);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(['configurar_empresa', 'emitir_nota']));
    const prompt = await client.getPrompt({
      name: 'emitir_nota',
      arguments: { pedido: 'consultoria para a Maria' },
    });
    expect(JSON.stringify(prompt.messages)).toContain('consultoria para a Maria');
  });

  it('configura a empresa: dados, logo, AbacatePay e link de certificado', async () => {
    const updated = await call('update_company', { tradeName: 'Abacate Dev' });
    expect(updated.structuredContent!.tradeName).toBe('Abacate Dev');
    expect(
      (await call('set_company_logo', { imageBase64: `data:image/png;base64,${PNG_B64}` }))
        .structuredContent
    ).toMatchObject({
      contentType: 'image/png',
    });
    const abacate = await call('enable_abacatepay_integration');
    expect(abacate.structuredContent!.webhookUrl).toMatch(/\/v1\/webhooks\/abacatepay\//);
    const link = await call('create_certificate_upload_link');
    expect(link.structuredContent!.url).toMatch(/\/v1\/public\/certificate-upload\//);
  });

  it('conecta o AbacatePay pela key, busca pagamentos antigos sem nota e emite', async () => {
    const today = new Date().toISOString();
    ctx.external.products = [
      { id: 'prod_suporte', name: 'Suporte técnico', price: 10000, cycle: null },
      { id: 'prod_teste', name: 'Produto teste', price: 100, cycle: null },
    ];
    ctx.external.customers = [{ id: 'cust_old', name: 'Cliente Antigo', email: 'old@x.com' }];
    ctx.external.history.checkouts = [
      {
        id: 'bill_old1',
        status: 'PAID',
        amount: 10000,
        paidAmount: 10000,
        items: [{ id: 'prod_suporte', quantity: 1 }],
        customerId: 'cust_old',
        createdAt: today,
        updatedAt: today,
      },
    ];
    const invalid = await call('connect_abacatepay', { apiKey: 'chave-invalida-123' });
    expect(invalid.isError).toBe(true);

    const connected = await call('connect_abacatepay', {
      apiKey: ctx.external.validKey,
      monthsBack: 1,
    });
    expect(connected.isError).toBeFalsy();
    expect(connected.structuredContent).toMatchObject({
      alreadyExisting: 1,
      skippedTestProducts: ['Produto teste'],
    });
    expect(connected.structuredContent!.pastSales.periods[0]).toMatchObject({
      isCurrentMonth: true,
      available: { count: 1, totalCents: 10000 },
    });

    const period = connected.structuredContent!.pastSales.periods[0].period;
    const issued = await call('issue_past_sales', { period });
    expect(issued.structuredContent).toMatchObject({ issued: 1, held: 0, failed: [] });
    await eventually(
      async () => ctx.email.sent.filter((m) => m.to === 'old@x.com').length,
      (n) => n === 1
    );

    // Sem buscar pagamentos antigos: só conecta (reconexão não duplica o webhook).
    const webhooks = ctx.external.webhooks.length;
    const again = await call('connect_abacatepay', {
      apiKey: ctx.external.validKey,
      scanPastSales: false,
    });
    expect(again.structuredContent!.pastSales).toBeUndefined();
    expect(ctx.external.webhooks.length).toBe(webhooks);
  });

  it('cadastra cliente, emite para ele, consulta a venda e estorna', async () => {
    const customer = await call('create_customer', {
      name: 'Maria Souza',
      taxId: '52998224725',
      email: 'maria@cliente.com',
    });
    const customerId = customer.structuredContent!.id;
    expect((await call('list_customers', { search: 'souza' })).structuredContent!.total).toBe(1);
    await call('update_customer', { id: customerId, phone: '11999990000' });
    expect((await call('get_customer', { id: customerId })).structuredContent!.phone).toBe(
      '5511999990000'
    );

    const products = await call('list_products');
    const productId = products.structuredContent!.items[0].id;
    expect(
      (await call('get_product', { id: productId })).structuredContent!.taxProfile
    ).toBeDefined();

    const issued = await call('issue_invoice', {
      externalId: 'mcp-sale-1',
      customerId,
      items: [
        { productExternalId: 'prod_suporte', totalCents: 10000 },
        { productExternalId: 'prod_consultoria', totalCents: 20000 },
      ],
    });
    const saleId = issued.structuredContent!.saleId;
    const sale = await eventually(
      async () => (await call('get_sale', { id: saleId })).structuredContent!,
      (s) =>
        s.invoices.length === 2 &&
        s.invoices.every((i: { status: string }) => i.status === 'ISSUED')
    );
    expect(sale.sale.customerId).toBe(customerId);
    expect(sale.invoices[0].customer.name).toBe('Maria Souza');
    expect(sale.sale).not.toHaveProperty('rawPayload');

    const refund = await call('refund_sale', { externalId: 'mcp-sale-1' });
    expect(refund.structuredContent!.invoices.map((i: { outcome: string }) => i.outcome)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect((await call('refund_sale', {})).isError).toBe(true);

    expect((await call('delete_customer', { id: customerId })).structuredContent).toEqual({
      deleted: true,
    });
    expect((await call('deactivate_product', { id: productId })).structuredContent!.active).toBe(
      false
    );
    expect((await call('remove_company_logo')).structuredContent).toEqual({ removed: true });
  });
});
