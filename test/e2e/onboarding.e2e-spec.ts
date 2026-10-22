import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABACATEPAY_PUBLIC_HMAC_KEY } from '../../src/adapters/in/webhooks/abacatepay.service.js';
import { generateTestPfx } from '../support/test-certificate.js';
import { findNonIntegerNumbers } from './support/integer-guard.js';
import { ADMIN_KEY, APP_KEY, E2EApp, eventually, startE2EApp } from './support/e2e-app.js';
import { brasilApiCompany } from './support/fake-external-apis.js';

type ToolResult = {
  isError?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  structuredContent?: Record<string, any>;
  content: { type: string; text?: string }[];
};

const CNPJ = '11222333000181';
const CNPJ_SP = '11444777000161';

describe('Onboarding self-service (app Replit → açaínfe → MCP)', () => {
  let ctx: E2EApp;
  let tenantId: string;
  let mcpKey: string;
  let client: Client;
  const http = () => request(ctx.baseUrl);
  const asUser = (r: request.Test, id = 'replit-user-1', email = 'dono@acai.dev') =>
    r
      .set('x-app-key', APP_KEY)
      .set('x-user-id', id)
      .set('x-user-email', email)
      .set('x-user-name', encodeURIComponent('Dona Açaí'));
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;

  beforeAll(async () => {
    ctx = await startE2EApp();
    ctx.external.companies.set(CNPJ, brasilApiCompany(CNPJ));
    ctx.external.companies.set(
      CNPJ_SP,
      brasilApiCompany(CNPJ_SP, {
        codigo_municipio_ibge: 3550308,
        municipio: 'SAO PAULO',
        razao_social: 'PAULISTA LTDA',
      })
    );
    const today = new Date().toISOString();
    ctx.external.history.checkouts = [
      {
        id: 'bill_hist1',
        status: 'PAID',
        amount: 50000,
        paidAmount: 50000,
        items: [{ id: 'prod_mentoria', quantity: 1 }],
        customerId: 'cust_h',
        createdAt: today,
        updatedAt: today,
      },
      {
        id: 'bill_hist2',
        status: 'PAID',
        amount: 50000,
        paidAmount: 50000,
        items: [{ id: 'prod_mentoria', quantity: 1 }],
        createdAt: today,
        updatedAt: today,
      },
      {
        id: 'bill_refund',
        status: 'REFUNDED',
        amount: 9900,
        items: [{ id: 'prod_comunidade', quantity: 1 }],
        createdAt: today,
        updatedAt: today,
      },
      {
        id: 'bill_pending',
        status: 'PENDING',
        amount: 9900,
        items: [],
        createdAt: today,
        updatedAt: today,
      },
    ];
    ctx.external.customers = [
      { id: 'cust_h', name: 'Cliente Antigo', email: 'antigo@x.com', cellphone: '11955554444' },
    ];
    ctx.external.products = [
      {
        id: 'prod_mentoria',
        externalId: 'mentoria',
        name: 'Mentoria individual',
        price: 50000,
        cycle: null,
      },
      {
        id: 'prod_comunidade',
        name: 'Comunidade mensal',
        price: 9900,
        cycle: 'MONTHLY',
        description: 'Acesso à comunidade',
      },
    ];
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await ctx?.close();
  });

  it('protege as rotas do app com a app key do backend e a identidade do usuário', async () => {
    await http().get('/v1/app/me').expect(401);
    await http()
      .get('/v1/app/me')
      .set('x-app-key', 'errada')
      .set('x-user-id', 'u')
      .set('x-user-email', 'a@b.com')
      .expect(401);
    await http().get('/v1/app/me').set('x-app-key', APP_KEY).expect(401);
  });

  it('etapa 1: perfil (e-mail vem do login; nome e WhatsApp do formulário)', async () => {
    const me = await asUser(http().get('/v1/app/me')).expect(200);
    expect(me.body).toMatchObject({
      user: { email: 'dono@acai.dev', name: 'Dona Açaí' },
      companies: [],
    });
    const updated = await asUser(http().put('/v1/app/me'))
      .send({ name: 'Dona Açaí', whatsapp: '(11) 97777-6666' })
      .expect(200);
    expect(updated.body.whatsapp).toBe('5511977776666');
    await asUser(http().put('/v1/app/me')).send({ whatsapp: '123' }).expect(422);
  });

  it('etapa 2: certificado → CNPJ → Receita → município liberado', async () => {
    const { pfx, password } = generateTestPfx({ cnpj: CNPJ });
    await asUser(http().post('/v1/app/onboarding/certificate'))
      .field('password', 'errada')
      .attach('file', pfx, 'a1.pfx')
      .expect(422);
    const res = await asUser(http().post('/v1/app/onboarding/certificate'))
      .field('password', password)
      .attach('file', pfx, 'a1.pfx')
      .expect(201);
    tenantId = res.body.tenant.id;
    expect(res.body.company).toMatchObject({
      legalName: 'AÇAÍ DIGITAL LTDA',
      cityName: 'Sao Bernardo Do Campo',
      simplesNacional: true,
    });
    expect(res.body.availability).toEqual({ status: 'READY' });
    expect(res.body.tenant).toMatchObject({
      cnpj: CNPJ,
      taxRegime: 'SIMPLES_NACIONAL',
      status: 'ACTIVE',
      phone: '5511977776666',
    });
    expect(res.body.tenant.cnaes.map((c: { code: string }) => c.code)).toEqual([
      '8599604',
      '6201501',
    ]);
    expect(res.body.readiness.missing.map((m: { field: string }) => m.field)).toEqual([
      'numbering',
      'businessType',
    ]);
    expect(res.body.readiness.recommended.map((m: { field: string }) => m.field)).toEqual([
      'municipalRegistration',
      'simplesNacionalTaxRateBps',
      'approximateTaxes',
    ]);
    // Cliente do app emite em produção; o sistema de emissão é só leitura.
    expect(res.body.emission).toMatchObject({ environment: 'PRODUCTION', system: 'NACIONAL' });
  });

  it('etapa 3: dados complementares; outro usuário não acessa a empresa', async () => {
    const res = await asUser(http().patch(`/v1/app/companies/${tenantId}`))
      .send({
        municipalRegistration: '123456',
        simplesNacionalTaxRateBps: 600,
        issuesElsewhere: false,
      })
      .expect(200);
    expect(res.body.readiness.missing.map((m: { field: string }) => m.field)).toEqual([
      'businessType',
    ]);
    // "O que você vende?" — opções vêm da API.
    const profiles = await asUser(http().get('/v1/app/fiscal-profiles')).expect(200);
    expect(profiles.body.map((p: { businessType: string }) => p.businessType)).toEqual([
      'INFOPRODUCER',
      'MICROSAAS',
      'CUSTOM',
    ]);
    expect(profiles.body[2]).toMatchObject({ validated: false, taxProfile: null });
    // Formulário avançado ("Outro serviço"): busca de código com as opções oficiais de NBS.
    const codes = await asUser(http().get('/v1/app/service-codes?q=design')).expect(200);
    expect(
      codes.body.find((c: { nationalServiceCode: string }) => c.nationalServiceCode === '230101')
    ).toMatchObject({
      nationalServiceCode: '230101',
      nbsOptions: expect.arrayContaining(['114093000']),
    });
    await asUser(
      http().get(`/v1/app/companies/${tenantId}/municipal-rate/230101`),
      'intruso',
      'x@x.com'
    ).expect(404);
    const answered = await asUser(http().patch(`/v1/app/companies/${tenantId}`))
      .send({
        businessType: 'MICROSAAS',
        approximateTaxes: {
          rateBps: 1553,
          descriptionTemplate: 'Valor aprox dos tributos: R$ [ValorTributos]. Fonte: IBPT',
        },
      })
      .expect(200);
    expect(answered.body.readiness).toEqual({ canIssue: true, missing: [], recommended: [] });
    expect(answered.body.tenant).toMatchObject({
      businessType: 'MICROSAAS',
      effectiveIssRateBps: 201,
    });
    await asUser(http().get(`/v1/app/companies/${tenantId}`), 'intruso', 'x@x.com').expect(404);
  });

  it('etapa 4: key do AbacatePay → webhook criado e catálogo importado para revisão', async () => {
    await asUser(http().post(`/v1/app/companies/${tenantId}/abacatepay`))
      .send({ apiKey: 'chave-invalida-xyz' })
      .expect(422);
    const res = await asUser(http().post(`/v1/app/companies/${tenantId}/abacatepay`))
      .send({ apiKey: ctx.external.validKey })
      .expect(201);
    expect(res.body).toMatchObject({ webhookId: 'webh_1', imported: 2 });
    // Já mostra as vendas pagas sem nota (estorno e pendente ficam de fora).
    expect(res.body.pastSales.periods[0]).toMatchObject({
      isCurrentMonth: true,
      available: { count: 2, totalCents: 100000 },
      refunded: 1,
    });
    expect(ctx.external.webhooks[0]).toMatchObject({
      endpoint: `https://api.acainfe.test/v1/webhooks/abacatepay/${tenantId}`,
      events: expect.arrayContaining([
        'checkout.completed',
        'subscription.renewed',
        'checkout.refunded',
      ]),
    });
    const pending = await asUser(
      http().get(`/v1/app/companies/${tenantId}/products?pendingTaxReview=true`)
    ).expect(200);
    expect(pending.body.total).toBe(2);
    // Perfil microSaaS ainda não validado: produtos importados chegam só com a sugestão.
    expect(pending.body.items[0].suggestedTaxProfile).toMatchObject({
      nationalServiceCode: '010501',
      nbsCode: '115062100',
    });
    const status = await asUser(http().get(`/v1/app/companies/${tenantId}`)).expect(200);
    expect(status.body.pendingTaxReview).toBe(2);
    // A tela de dados da empresa mostra a validade do certificado.
    expect(status.body.certificate).toMatchObject({ present: true, expired: false });
    expect(new Date(status.body.certificate.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(status.body.tenant.integrations).toEqual({
      abacatepay: true,
      abacatepayConnectedViaApi: true,
    });
  });

  it('venda chega antes da tributação: fica retida', async () => {
    const secret = String(ctx.external.webhooks[0].secret);
    const payload = JSON.stringify({
      event: 'checkout.completed',
      data: {
        checkout: {
          id: 'bill_early',
          amount: 50000,
          paidAmount: 50000,
          items: [{ id: 'prod_mentoria', quantity: 1 }],
        },
        customer: { id: 'cust_1', name: 'Aluno', email: 'aluno@x.com' },
      },
    });
    const res = await http()
      .post(`/v1/webhooks/abacatepay/${tenantId}?webhookSecret=${secret}`)
      .set('Content-Type', 'application/json')
      .set(
        'X-Webhook-Signature',
        createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY).update(payload).digest('base64')
      )
      .send(payload)
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'HELD',
      reasons: [expect.stringMatching(/Mentoria individual/)],
    });
  });

  it('etapa 5: key do MCP; agente define a tributação com o usuário e a venda retida vira nota', async () => {
    // Igual ao app do Replit: Content-Type JSON e corpo vazio (antes dava 400 do Fastify).
    const res = await asUser(http().post(`/v1/app/companies/${tenantId}/mcp-key`))
      .set('Content-Type', 'application/json')
      .expect(201);
    const malformed = await asUser(http().patch(`/v1/app/companies/${tenantId}`))
      .set('Content-Type', 'application/json')
      .send('{"issuesElsewhere": tru')
      .expect(400);
    expect(malformed.body.message).toMatch(/JSON inválido/);
    mcpKey = res.body.apiKey;
    expect(res.body.claudeCodeCommand).toBe(
      `claude mcp add --transport http acainfe https://api.acainfe.test/mcp --header "Authorization: Bearer ${mcpKey}"`
    );
    expect(JSON.parse(res.body.jsonConfig).mcpServers.acainfe.headers.Authorization).toBe(
      `Bearer ${mcpKey}`
    );
    // Guia sem gerar chave (ex.: guardou a chave mas esqueceu como conectar).
    const guide = await asUser(http().get(`/v1/app/companies/${tenantId}/mcp-connection`)).expect(
      200
    );
    expect(guide.body).toMatchObject({
      mcpUrl: 'https://api.acainfe.test/mcp',
      keyPlaceholder: '<SUA_CHAVE>',
      claudeCodeCommand:
        'claude mcp add --transport http acainfe https://api.acainfe.test/mcp --header "Authorization: Bearer <SUA_CHAVE>"',
    });
    expect(JSON.stringify(guide.body)).not.toContain(mcpKey);
    client = new Client({ name: 'agente', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${mcpKey}` } },
      })
    );

    const company = await call('get_company');
    expect(company.structuredContent).toMatchObject({
      pendingTaxReview: 2,
      readiness: { canIssue: true },
      availability: { status: 'READY' },
    });
    expect(company.structuredContent!.cnaes[0].description).toMatch(/Treinamento/);

    const pending = await call('list_pending_products');
    const mentoria = pending.structuredContent!.products.find(
      (p: { externalId: string }) => p.externalId === 'prod_mentoria'
    );
    expect(mentoria.name).toBe('Mentoria individual');

    const denied = await call('confirm_product_tax', {
      id: mentoria.id,
      taxProfile: { nationalServiceCode: '080201' },
      userConfirmed: false,
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/userConfirmed/);

    const ok = await call('confirm_product_tax', {
      id: mentoria.id,
      taxProfile: { nationalServiceCode: '080201' },
      userConfirmed: true,
      note: 'CNAE 8599-6/04 — treinamento profissional',
    });
    expect(ok.structuredContent).toMatchObject({
      product: { taxStatus: 'CONFIRMED' },
      releasedHeldSales: 1,
    });

    const issued = await eventually(
      async () => (await call('list_invoices', { status: ['ISSUED'] })).structuredContent!,
      (r) => r.total === 1
    );
    expect(issued.items[0]).toMatchObject({
      amountCents: 50000,
      taxProfile: { nationalServiceCode: '080201' },
    });
    await eventually(
      async () => ctx.email.sent.filter((m) => m.to === 'aluno@x.com').length,
      (n) => n === 1
    );
    expect((await call('list_pending_products')).structuredContent!.total).toBe(1);

    // Vendas antigas: o usuário marca uma como "já emitida no eNotas" e emite a outra pelo app.
    const period = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 7);
    const items = await asUser(
      http().get(`/v1/app/companies/${tenantId}/past-sales/items?period=${period}&status=AVAILABLE`)
    ).expect(200);
    const hist2 = items.body.find((i: { externalId: string }) => i.externalId === 'bill_hist2');
    await asUser(http().post(`/v1/app/companies/${tenantId}/past-sales/mark`))
      .send({ ids: [hist2.id], alreadyIssued: true })
      .expect(201);
    const pastIssued = await asUser(http().post(`/v1/app/companies/${tenantId}/past-sales/issue`))
      .send({ period })
      .expect(201);
    expect(pastIssued.body).toMatchObject({ issued: 1, held: 0, failed: [] });
    await eventually(
      async () => ctx.email.sent.filter((m) => m.to === 'antigo@x.com').length,
      (n) => n === 1
    );
    const summary = await call('list_past_sales');
    expect(summary.structuredContent!.periods[0]).toMatchObject({
      imported: 1,
      alreadyIssued: 1,
      refunded: 1,
    });
  });

  it('lista de espera: município não integrado; ao liberar, ativa e avisa por e-mail e WhatsApp', async () => {
    const user = (r: request.Test) => asUser(r, 'replit-user-2', 'paulista@x.com');
    await user(http().put('/v1/app/me'))
      .send({ name: 'Paulista', whatsapp: '11966665555' })
      .expect(200);
    const { pfx, password } = generateTestPfx({ cnpj: CNPJ_SP });
    const res = await user(http().post('/v1/app/onboarding/certificate'))
      .send({ pfxBase64: pfx.toString('base64'), password })
      .expect(201);
    expect(res.body.availability).toEqual({
      status: 'WAITLIST',
      reason: 'Sao Paulo/SP ainda não está integrado ao açaínfe',
    });
    const spId = res.body.tenant.id;
    await user(http().post(`/v1/app/companies/${spId}/abacatepay`))
      .send({ apiKey: ctx.external.validKey })
      .expect(409);

    const waitlist = await http()
      .get('/v1/admin/waitlist')
      .set('x-admin-key', ADMIN_KEY)
      .expect(200);
    expect(waitlist.body).toEqual([
      { cityCode: '3550308', cityName: 'Sao Paulo', uf: 'SP', simples: 1, others: 0 },
    ]);
    await http().get('/v1/admin/waitlist').expect(401);

    const released = await http()
      .put('/v1/admin/coverage/3550308')
      .set('x-admin-key', ADMIN_KEY)
      .send({ cityName: 'São Paulo', uf: 'SP', simples: true, others: false })
      .expect(200);
    expect(released.body.released).toBe(1);
    expect(ctx.whatsapp.texts.at(-1)).toMatchObject({
      phone: '5511966665555',
      text: expect.stringContaining('PAULISTA LTDA'),
    });
    expect(
      ctx.email.sent.some((m) => m.to === 'paulista@x.com' && /já pode emitir/.test(m.subject))
    ).toBe(true);
    const now = await user(http().get(`/v1/app/companies/${spId}`)).expect(200);
    expect(now.body.availability).toEqual({ status: 'READY' });

    // Cadastro mínimo (o dev de madrugada): numeração e "o que você vende"; CCM e alíquota ficam para depois.
    const minimal = await user(http().patch(`/v1/app/companies/${spId}`))
      .send({ issuesElsewhere: false, businessType: 'INFOPRODUCER' })
      .expect(200);
    expect(minimal.body.readiness).toMatchObject({ canIssue: true, missing: [] });
    expect(minimal.body.readiness.recommended.map((r: { field: string }) => r.field)).toEqual([
      'municipalRegistration',
      'simplesNacionalTaxRateBps',
      'approximateTaxes',
    ]);

    const coverage = await http()
      .get('/v1/admin/coverage')
      .set('x-admin-key', ADMIN_KEY)
      .expect(200);
    expect(coverage.body.map((c: { cityCode: string }) => c.cityCode).sort()).toEqual([
      '3548708',
      '3550308',
    ]);
    const me = await user(http().get('/v1/app/me')).expect(200);
    expect(me.body.companies).toHaveLength(1);
  });
  it('produto pelo app: sem tributação recebe a sugestão do perfil; o usuário confirma com um clique', async () => {
    const created = await asUser(http().post(`/v1/app/companies/${tenantId}/products`))
      .send({ name: 'Plano Anual' })
      .expect(201);
    expect(created.body).toMatchObject({
      taxStatus: 'PENDING_REVIEW',
      suggestedTaxProfile: { nationalServiceCode: '010501' },
    });
    await asUser(
      http().post(`/v1/app/companies/${tenantId}/products/${created.body.id}/confirm-tax`)
    )
      .send({ userConfirmed: false })
      .expect(422);
    const confirmed = await asUser(
      http().post(`/v1/app/companies/${tenantId}/products/${created.body.id}/confirm-tax`)
    )
      .send({ userConfirmed: true })
      .expect(201);
    expect(confirmed.body.product).toMatchObject({
      taxStatus: 'CONFIRMED',
      taxConfirmation: { via: 'APP' },
      taxProfile: { nationalServiceCode: '010501', nbsCode: '115062100' },
      warnings: [],
    });
  });

  it('recria o webhook do AbacatePay na URL atual; o segredo antigo para de valer', async () => {
    const before = ctx.external.webhooks.length;
    const oldSecret = String(ctx.external.webhooks[0].secret);
    const res = await asUser(
      http().post(`/v1/app/companies/${tenantId}/abacatepay/webhook`)
    ).expect(201);
    expect(res.body).toMatchObject({
      endpoint: `https://api.acainfe.test/v1/webhooks/abacatepay/${tenantId}`,
      previous: { webhookId: 'webh_1' },
    });
    expect(ctx.external.webhooks).toHaveLength(before + 1);
    const newSecret = String(ctx.external.webhooks.at(-1)!.secret);
    const payload = JSON.stringify({
      event: 'checkout.completed',
      data: { checkout: { id: 'x' } },
    });
    const sig = createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY).update(payload).digest('base64');
    const send = (secret: string) =>
      http()
        .post(`/v1/webhooks/abacatepay/${tenantId}?webhookSecret=${secret}`)
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', sig)
        .send(payload);
    await send(oldSecret).expect(401);
    await send(newSecret).expect(200);
    const status = await asUser(http().get(`/v1/app/companies/${tenantId}`)).expect(200);
    expect(status.body.abacatepay).toMatchObject({ connected: true, webhookUpToDate: true });
  });

  it('ficha fiscal: mostra tudo o que define as notas e envia ao contador', async () => {
    const res = await asUser(http().get(`/v1/app/companies/${tenantId}/fiscal-settings`)).expect(
      200
    );
    expect(res.body).toMatchObject({
      company: { cnpj: '11222333000181', municipalRegistration: '123456' },
      emission: { system: 'NACIONAL', environment: 'PRODUCTION' },
      approximateTaxes: { rateBps: 1553 },
      certificate: { present: true },
    });
    expect(res.body.text).toContain('FICHA FISCAL');
    await asUser(
      http().get(`/v1/app/companies/${tenantId}/fiscal-settings`),
      'intruso',
      'x@x.com'
    ).expect(404);
    await asUser(http().put(`/v1/app/companies/${tenantId}/accountant`))
      .send({ email: 'contador@x.com' })
      .expect(200);
    const sent = await asUser(
      http().post(`/v1/app/companies/${tenantId}/fiscal-settings/send`)
    ).expect(201);
    expect(sent.body).toEqual({ sentTo: { email: 'contador@x.com' } });
    expect(
      ctx.email.sent.some((m) => m.to === 'contador@x.com' && /FICHA FISCAL/.test(m.text))
    ).toBe(true);
  });

  it('chaves do MCP: lista sem segredo, revoga uma (para na hora) e revoga todas', async () => {
    const created = await asUser(http().post(`/v1/app/companies/${tenantId}/mcp-key`))
      .send({ label: 'Notebook' })
      .expect(201);
    expect(created.body.key).toMatchObject({ label: 'Notebook', legacy: false });
    const leaked: string = created.body.apiKey;
    await http().get('/v1/tenants/me').set('x-api-key', leaked).expect(200);

    const list = await asUser(http().get(`/v1/app/companies/${tenantId}/mcp-keys`)).expect(200);
    expect(list.body.items[0]).toMatchObject({ id: created.body.key.id, label: 'Notebook' });
    expect(JSON.stringify(list.body)).not.toContain(leaked);
    const others = list.body.items.length - 1;

    const revoked = await asUser(
      http().delete(`/v1/app/companies/${tenantId}/mcp-keys/${created.body.key.id}`)
    ).expect(200);
    expect(revoked.body).toEqual({ revoked: created.body.key.id, remaining: others });
    await http().get('/v1/tenants/me').set('x-api-key', leaked).expect(401);
    await http().post('/mcp').set('Authorization', `Bearer ${leaked}`).send({}).expect(401);
    await asUser(http().get(`/v1/app/companies/${tenantId}/mcp-keys`), 'intruso', 'x@x.com').expect(
      404
    );

    await asUser(http().delete(`/v1/app/companies/${tenantId}/mcp-keys`)).expect(200);
    const empty = await asUser(http().get(`/v1/app/companies/${tenantId}/mcp-keys`)).expect(200);
    expect(empty.body.items).toEqual([]);
  });

  it('todos os valores numéricos persistidos são inteiros (centavos, pontos-base)', async () => {
    expect(await findNonIntegerNumbers(ctx.container.db)).toEqual([]);
  });
});
