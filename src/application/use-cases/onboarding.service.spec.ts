import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness, sampleCompany } from '../../../test/support/app-harness.js';
import { generateTestPfx } from '../../../test/support/test-certificate.js';
import { NOW } from '../../../test/support/fixtures.js';
import { createCoverage } from '../../domain/tenant/coverage.js';

const SBC = { cityCode: '3548708', cityName: 'São Bernardo do Campo', uf: 'SP' };

describe('Onboarding self-service', () => {
  let h: ReturnType<typeof buildAppHarness>;
  const cert = () =>
    generateTestPfx({
      notBefore: new Date(NOW.getTime() - 86_400_000),
      notAfter: new Date(NOW.getTime() + 365 * 86_400_000),
    });

  beforeEach(async () => {
    h = buildAppHarness();
    await h.repos.coverage.upsert(createCoverage({ ...SBC, simples: true, others: false }, NOW));
  });

  const login = async (externalId = 'replit-1', email = 'dono@empresa.com') => {
    const user = await h.accounts.identify({ externalId, email, name: 'Dono' });
    return h.accounts.updateProfile(user, { whatsapp: '(11) 98888-7777' });
  };

  it('certificado → CNPJ → Receita → empresa pronta (Simples em SBC) com pendências claras', async () => {
    const user = await login();
    const { pfx, password } = cert();
    const result = await h.onboarding.submitCertificate(user, pfx, password);
    expect(result.company.legalName).toBe('EMPRESA TESTE LTDA');
    expect(result.availability).toEqual({ status: 'READY' });
    expect(result.tenant).toMatchObject({
      cnpj: '11222333000181',
      cityCode: '3548708',
      taxRegime: 'SIMPLES_NACIONAL',
      status: 'ACTIVE',
      email: 'dono@empresa.com',
      phone: '5511988887777',
      cnaes: [expect.objectContaining({ code: '6201501', primary: true }), expect.anything()],
    });
    expect(result.readiness.canIssue).toBe(false);
    // Só a numeração bloqueia; CCM e alíquota do Simples são recomendações (não travam quem cadastra de madrugada).
    expect(result.readiness.missing.map((m) => m.field)).toEqual(['numbering', 'businessType']);
    expect(result.readiness.recommended.map((m) => m.field)).toEqual([
      'municipalRegistration',
      'simplesNacionalTaxRateBps',
      'approximateTaxes',
    ]);
    expect(result.emission).toMatchObject({ system: 'NACIONAL', environment: 'PRODUCTION' });
    expect((await h.certificates.status(result.tenant.id)).present).toBe(true);
    // Validade do certificado para o app exibir (tela de dados da empresa).
    expect(result.certificate).toMatchObject({
      present: true,
      expired: false,
      expiresAt: expect.any(Date),
      validFrom: expect.any(Date),
      cnpj: '11222333000181',
    });
    expect(result.certificate.daysUntilExpiry).toBeGreaterThan(300);

    const done = await h.onboarding.completeCompany(
      (await h.repos.tenants.findById(result.tenant.id))!,
      {
        municipalRegistration: '12.345-6',
        simplesNacionalTaxRateBps: 600,
        issuesElsewhere: true,
        businessType: 'INFOPRODUCER',
        approximateTaxes: {
          rateBps: 1553,
          descriptionTemplate: 'Valor aprox dos tributos: R$ [ValorTributos]. Fonte: IBPT',
        },
      }
    );
    expect(done.readiness).toEqual({ canIssue: true, missing: [], recommended: [] });
    // Simples: ISS = 6% × 33,5% (parcela do ISS no Anexo III) = 2,01%, sem perguntar nada.
    expect(done.tenant).toMatchObject({ businessType: 'INFOPRODUCER', effectiveIssRateBps: 201 });
    expect(done.tenant).toMatchObject({ dpsSeries: '900', lastDpsNumber: 0 });
    const me = (await h.repos.users.findById(user.id))!;
    expect(me.tenantIds).toEqual([result.tenant.id]);
  });

  it('município não integrado ou regime não liberado → lista de espera com motivo', async () => {
    h.registry.companies.set(
      '11222333000181',
      sampleCompany({ cityCode: '3550308', cityName: 'São Paulo' })
    );
    const { pfx, password } = cert();
    const r = await h.onboarding.submitCertificate(await login(), pfx, password);
    expect(r.availability).toEqual({
      status: 'WAITLIST',
      reason: 'São Paulo/SP ainda não está integrado ao açaínfe',
    });
    expect(r.readiness.missing[0].field).toBe('status');

    const h2 = buildAppHarness();
    await h2.repos.coverage.upsert(createCoverage({ ...SBC, simples: true, others: false }, NOW));
    h2.registry.companies.set('11222333000181', sampleCompany({ simplesNacional: false }));
    const user2 = await h2.accounts.identify({ externalId: 'x', email: 'x@x.com' });
    const r2 = await h2.onboarding.submitCertificate(user2, pfx, password);
    expect(r2.tenant.taxRegime).toBe('LUCRO_PRESUMIDO');
    expect(r2.availability).toMatchObject({
      status: 'WAITLIST',
      reason: expect.stringMatching(/Lucro Presumido/),
    });

    // Corrigiu o regime para Simples: sai da espera.
    const fixed = await h2.onboarding.completeCompany(
      (await h2.repos.tenants.findById(r2.tenant.id))!,
      { taxRegime: 'SIMPLES_NACIONAL' }
    );
    expect(fixed.availability).toEqual({ status: 'READY' });
  });

  it('rejeita certificado sem CNPJ, CNPJ inexistente ou inativo', async () => {
    const user = await login();
    const noCnpj = generateTestPfx({ commonName: 'PESSOA FISICA:12345678909', cnpj: '000' });
    await expect(h.onboarding.submitCertificate(user, noCnpj.pfx, noCnpj.password)).rejects.toThrow(
      /e-CNPJ/
    );
    const unknown = generateTestPfx({ cnpj: '11444777000161' });
    await expect(
      h.onboarding.submitCertificate(user, unknown.pfx, unknown.password)
    ).rejects.toThrow(/não encontrado/);
    h.registry.companies.set(
      '11444777000161',
      sampleCompany({ cnpj: '11444777000161', active: false, situation: 'BAIXADA' })
    );
    await expect(
      h.onboarding.submitCertificate(user, unknown.pfx, unknown.password)
    ).rejects.toThrow(/BAIXADA/);
    await expect(h.onboarding.submitCertificate(user, Buffer.alloc(0), 'x')).rejects.toThrow(
      /Envie/
    );
  });

  it('outro usuário com o mesmo certificado passa a administrar a empresa existente', async () => {
    const { pfx, password } = cert();
    const first = await h.onboarding.submitCertificate(await login('a', 'a@x.com'), pfx, password);
    const second = await h.onboarding.submitCertificate(await login('b', 'b@x.com'), pfx, password);
    expect(second.tenant.id).toBe(first.tenant.id);
    expect(second.tenant.ownerUserIds).toHaveLength(2);
  });

  it('conecta AbacatePay: cria webhook e importa catálogo aguardando tributação', async () => {
    const user = await login();
    const { pfx, password } = cert();
    const { tenant: view } = await h.onboarding.submitCertificate(user, pfx, password);
    const tenant = (await h.repos.tenants.findById(view.id))!;
    h.gateway.products = [
      { id: 'prod_a', name: 'Mentoria', priceCents: 50000, recurring: false },
      {
        id: 'prod_b',
        name: 'Plano mensal',
        priceCents: 9900,
        recurring: true,
        description: 'Acesso à comunidade',
      },
    ];
    await expect(h.onboarding.connectAbacatePay(tenant, 'errada-123456')).rejects.toThrow(
      /inválida/
    );

    const r = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    expect(r).toMatchObject({ webhookId: 'webh_1', imported: 2, alreadyExisting: 0 });
    const hook = h.gateway.webhooks[0];
    expect(hook.endpoint).toBe(`https://api.acainfe.test/v1/webhooks/abacatepay/${tenant.id}`);
    expect(hook.events).toEqual(
      expect.arrayContaining(['checkout.completed', 'checkout.refunded', 'subscription.renewed'])
    );
    const stored = (await h.repos.tenants.findById(tenant.id))!.integrations.abacatepay!;
    expect(stored).toMatchObject({ webhookSecret: hook.secret, webhookId: 'webh_1' });
    expect(stored.encryptedApiKey).not.toContain(h.gateway.validKey);

    const pending = await h.products.list(tenant.id, { pendingTaxReview: true });
    expect(pending.items.map((p) => [p.externalId, p.taxStatus])).toEqual([
      ['prod_a', 'PENDING_REVIEW'],
      ['prod_b', 'PENDING_REVIEW'],
    ]);
    expect((await h.onboarding.status(tenant)).pendingTaxReview).toBe(2);

    const again = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    expect(again).toMatchObject({ imported: 0, alreadyExisting: 2 });
  });

  it('produto padrão: sugerido com um produto só, vira pendência até decidir e sobrevive à reconexão', async () => {
    const user = await login();
    const { pfx, password } = cert();
    const { tenant: view } = await h.onboarding.submitCertificate(user, pfx, password);
    const tenant = (await h.repos.tenants.findById(view.id))!;
    await expect(h.onboarding.setDefaultProduct(tenant, null)).rejects.toThrow(/Conecte/);
    h.gateway.products = [{ id: 'prod_a', name: 'Mentoria', priceCents: 50000, recurring: false }];

    const r = await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    const [mentoria] = (await h.products.list(tenant.id, {})).items;
    expect(r.defaultProduct).toEqual({
      decided: false,
      productId: null,
      suggestedProductId: mentoria.id,
      options: [{ id: mentoria.id, name: 'Mentoria' }],
    });
    const fields = async () =>
      (await h.onboarding.status((await h.repos.tenants.findById(tenant.id))!)).readiness.recommended.map(
        (i) => i.field
      );
    expect(await fields()).toContain('defaultProduct');

    await expect(h.onboarding.setDefaultProduct(tenant, 'nao-existe')).rejects.toThrow(/Produto/);
    expect(await h.onboarding.setDefaultProduct(tenant, mentoria.id)).toMatchObject({
      defaultProduct: { decided: true, productId: mentoria.id },
    });
    expect(await fields()).not.toContain('defaultProduct');

    const again = await h.onboarding.connectAbacatePay(
      (await h.repos.tenants.findById(tenant.id))!,
      h.gateway.validKey
    );
    expect(again.defaultProduct).toMatchObject({ decided: true, productId: mentoria.id });

    // "Nenhum" também é uma decisão: some da pendência e não há produto padrão.
    expect(await h.onboarding.setDefaultProduct(tenant, null)).toMatchObject({
      defaultProduct: { decided: true, productId: null },
    });
    expect(await fields()).not.toContain('defaultProduct');
  });

  it('empresa na lista de espera não conecta gateway nem emite', async () => {
    h.registry.companies.set('11222333000181', sampleCompany({ cityCode: '3550308' }));
    const { pfx, password } = cert();
    const { tenant: view } = await h.onboarding.submitCertificate(await login(), pfx, password);
    const tenant = (await h.repos.tenants.findById(view.id))!;
    await expect(h.onboarding.connectAbacatePay(tenant, h.gateway.validKey)).rejects.toThrow(
      /lista de espera/
    );
    await expect(
      h.sales.register(tenant, {
        source: 'API',
        externalId: 'x',
        items: [{ productId: 'p', totalCents: 1 }],
      })
    ).rejects.toThrow(/lista de espera/);
  });

  it('gera a key do MCP com o comando pronto', async () => {
    const { pfx, password } = cert();
    const { tenant: view } = await h.onboarding.submitCertificate(await login(), pfx, password);
    const tenant = (await h.repos.tenants.findById(view.id))!;
    const r = await h.onboarding.issueMcpKey(tenant);
    expect(r.mcpUrl).toBe('https://api.acainfe.test/mcp');
    expect(r.claudeCodeCommand).toContain(`Bearer ${r.apiKey}`);
    expect((await h.tenants.authenticate(r.apiKey)).id).toBe(tenant.id);
    const second = await h.onboarding.issueMcpKey(tenant);
    expect((await h.tenants.authenticate(r.apiKey)).id).toBe(tenant.id); // a anterior continua válida
    expect(second.apiKey).not.toBe(r.apiKey);
  });

  it('liberar o município ativa quem estava na espera e avisa por e-mail e WhatsApp', async () => {
    h.registry.companies.set(
      '11222333000181',
      sampleCompany({ cityCode: '3550308', cityName: 'São Paulo' })
    );
    const { pfx, password } = cert();
    const { tenant } = await h.onboarding.submitCertificate(await login(), pfx, password);
    expect(await h.onboarding.waitlistSummary()).toEqual([
      { cityCode: '3550308', cityName: 'São Paulo', uf: 'SP', simples: 1, others: 0 },
    ]);

    const none = await h.onboarding.setCoverage({
      cityCode: '3550308',
      simples: false,
      others: true,
    });
    expect(none.released).toBe(0);
    const r = await h.onboarding.setCoverage({
      cityCode: '3550308',
      cityName: 'São Paulo',
      uf: 'SP',
      simples: true,
      others: false,
    });
    expect(r.released).toBe(1);
    expect((await h.repos.tenants.findById(tenant.id))!.status).toBe('ACTIVE');
    expect(h.email.sent.at(-1)!.subject).toMatch(/já pode emitir/);
    expect(h.whatsapp.texts[0]).toMatchObject({
      phone: '5511988887777',
      text: expect.stringContaining('São Paulo'),
    });
    expect(await h.onboarding.waitlistSummary()).toEqual([]);
    expect((await h.onboarding.listCoverage()).map((c) => c.cityCode).sort()).toEqual([
      '3548708',
      '3550308',
    ]);
  });
});

describe('Contas', () => {
  it('identifica, atualiza perfil e protege empresas de outros usuários', async () => {
    const h = buildAppHarness();
    const u = await h.accounts.identify({ externalId: 'r1', email: 'A@x.com' });
    expect((await h.accounts.identify({ externalId: 'r1', email: 'a@x.com' })).id).toBe(u.id);
    expect((await h.accounts.identify({ externalId: 'r1', email: 'novo@x.com' })).email).toBe(
      'novo@x.com'
    );
    await expect(h.accounts.updateProfile(u, { name: ' ' })).rejects.toThrow(/nome/);
    await expect(h.accounts.updateProfile(u, { whatsapp: '12' })).rejects.toThrow(/Telefone/);
    const { tenant } = await h.onboard({ withCertificate: false });
    await expect(h.accounts.ownedTenant(u, tenant.id)).rejects.toThrow(/não encontrad/);
    expect(await h.accounts.tenantsOf(u)).toEqual([]);
  });
});

describe('Vendas retidas (produto sem tributação)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];
  let pendingId: string;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    const { createImportedProduct } = await import('../../domain/product/product.js');
    const p = createImportedProduct(
      'pend-1',
      tenant.id,
      { externalId: 'prod_x', name: 'Mentoria', priceCents: 1000 },
      NOW
    );
    await h.repos.products.create(p);
    pendingId = p.id;
  });

  it('webhook retém a venda; ao confirmar a tributação ela vira nota', async () => {
    const input = {
      source: 'ABACATEPAY' as const,
      externalId: 'bill_1',
      totalCents: 1000,
      customer: { email: 'c@x.com' },
      items: [{ productExternalId: 'prod_x' }],
    };
    await expect(h.sales.register(tenant, input)).rejects.toThrow(
      /aguarda a definição da tributação/
    );

    const held = await h.sales.register(tenant, input, { holdIfNotReady: true });
    expect(held).toMatchObject({ held: true, invoices: [] });
    expect(held.sale.held!.reasons[0]).toMatch(/Mentoria/);
    expect((await h.sales.register(tenant, input, { holdIfNotReady: true })).held).toBe(true);
    expect(await h.sales.resumeHeld(tenant.id)).toBe(0);

    await expect(
      h.products.confirmTax(
        tenant,
        pendingId,
        { nationalServiceCode: '080201' },
        { userConfirmed: false, via: 'MCP' }
      )
    ).rejects.toThrow(/userConfirmed/);
    const confirmed = await h.products.confirmTax(
      tenant,
      pendingId,
      { nationalServiceCode: '080201' },
      { userConfirmed: true, via: 'MCP', note: 'CNAE 8599-6/04 — treinamento' }
    );
    expect(confirmed).toMatchObject({
      taxStatus: 'CONFIRMED',
      taxConfirmation: { via: 'MCP', note: expect.stringMatching(/CNAE/) },
    });

    expect(await h.sales.resumeHeld(tenant.id)).toBe(1);
    const sale = await h.sales.get(tenant.id, held.sale.id);
    expect(sale.sale.held).toBeUndefined();
    expect(sale.invoices).toHaveLength(1);
    expect(sale.invoices[0]).toMatchObject({
      amountCents: 1000,
      taxProfile: { nationalServiceCode: '080201' },
    });
    expect(h.scheduler.issues.map((i) => i.invoiceId)).toContain(sale.invoices[0].id);
    expect(await h.sales.resumeHeld()).toBe(0);
  });

  it('produto não cadastrado também retém; venda estornada antes de liberar não gera nota', async () => {
    const held = await h.sales.register(
      tenant,
      {
        source: 'ABACATEPAY',
        externalId: 'bill_2',
        totalCents: 500,
        items: [{ productExternalId: 'prod_novo' }],
      },
      { holdIfNotReady: true }
    );
    expect(held.sale.held!.reasons[0]).toMatch(/não cadastrado/);
    await h.refunds.refundSale(tenant, { saleId: held.sale.id }, { requestedBy: 'ABACATEPAY' });
    await h.products.create(tenant, {
      name: 'Novo',
      externalId: 'prod_novo',
      taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900' },
    });
    expect(await h.sales.resumeHeld(tenant.id)).toBe(0);
  });
});
