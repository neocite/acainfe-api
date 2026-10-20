import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { NOW } from '../../../test/support/fixtures.js';
import { generateTestPfx } from '../../../test/support/test-certificate.js';
import { explainFiscalErrors } from './fiscal-error-hints.js';
import { hashApiKey } from './tenant.service.js';

describe('TenantService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  beforeEach(() => {
    h = buildAppHarness();
  });

  it('cria empresa, autentica pela API key e não expõe hashes', async () => {
    const { tenant, apiKey } = await h.onboard({ withCertificate: false });
    expect(apiKey).toMatch(/^acai_/);
    expect((await h.tenants.authenticate(apiKey)).id).toBe(tenant.id);
    const created = await h.tenants.update(tenant.id, {});
    expect(created).not.toHaveProperty('apiKeyHashes');
    await expect(h.tenants.authenticate('errada')).rejects.toThrow(/inválida/);
    await expect(h.tenants.authenticate(undefined)).rejects.toThrow(/ausente/);
  });

  it('impede CNPJ duplicado', async () => {
    await h.onboard({ withCertificate: false });
    await expect(h.onboard({ withCertificate: false })).rejects.toThrow(/Já existe/);
  });

  it('atualiza preservando numeração do DPS e valida', async () => {
    const { tenant } = await h.onboard({ withCertificate: false });
    await h.repos.tenants.reserveDpsNumbers(tenant.id, 5);
    const updated = await h.tenants.update(tenant.id, {
      tradeName: 'Fantasia',
      notifications: { whatsapp: false },
    });
    expect(updated).toMatchObject({
      tradeName: 'Fantasia',
      notifications: { email: true, whatsapp: false },
    });
    expect((await h.repos.tenants.findById(tenant.id))!.lastDpsNumber).toBe(5);
    await expect(h.tenants.update(tenant.id, { email: 'invalido' })).rejects.toThrow(/E-mail/);
    await expect(h.tenants.get('nope')).rejects.toThrow(/não encontrado/);
  });

  it('rotaciona a API key invalidando a anterior', async () => {
    const { tenant, apiKey } = await h.onboard({ withCertificate: false });
    const { apiKey: newKey } = await h.tenants.rotateApiKey(tenant.id);
    await expect(h.tenants.authenticate(apiKey)).rejects.toThrow();
    expect((await h.tenants.authenticate(newKey)).id).toBe(tenant.id);
    expect(hashApiKey(newKey)).toHaveLength(64);
  });

  it('gera URL do webhook AbacatePay com segredo', async () => {
    const { tenant } = await h.onboard({ withCertificate: false });
    const { webhookUrl, webhookSecret } = await h.tenants.enableAbacatePay(
      tenant.id,
      'https://api.xn--aanfe-yra7b.com/'
    );
    expect(webhookUrl).toBe(
      `https://api.xn--aanfe-yra7b.com/v1/webhooks/abacatepay/${tenant.id}?webhookSecret=${webhookSecret}`
    );
    expect(
      (await h.repos.tenants.findById(tenant.id))!.integrations.abacatepay!.webhookSecret
    ).toBe(webhookSecret);
  });
});

describe('CertificateService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];
  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard({ withCertificate: false })).tenant;
  });

  it('valida, cifra e ativa o certificado', async () => {
    const { pfx, password } = generateTestPfx();
    const status = await h.certificates.upload(tenant, pfx, password);
    expect(status).toMatchObject({
      present: true,
      expired: false,
      metadata: { cnpj: '11222333000181' },
    });
    const stored = h.repos.certificates.items[0];
    expect(stored.encryptedPfx).not.toContain(pfx.toString('base64').slice(0, 20) + 'X');
    expect(stored.encryptedPassword.startsWith('enc:')).toBe(true);
    const material = await h.certificates.loadMaterial(tenant);
    expect(material.password).toBe(password);
    expect(material.pfx.equals(pfx)).toBe(true);
  });

  it('rejeita senha errada, outro CNPJ, vencido e arquivo vazio', async () => {
    const { pfx } = generateTestPfx();
    await expect(h.certificates.upload(tenant, pfx, 'errada')).rejects.toThrow(/senha incorreta/);
    const other = generateTestPfx({ cnpj: '11444777000161' });
    await expect(h.certificates.upload(tenant, other.pfx, other.password)).rejects.toThrow(
      /outro CNPJ/
    );
    const expired = generateTestPfx({
      notBefore: new Date('2025-01-01'),
      notAfter: new Date('2026-01-01'),
    });
    await expect(h.certificates.upload(tenant, expired.pfx, expired.password)).rejects.toThrow(
      /vencido/
    );
    await expect(h.certificates.upload(tenant, Buffer.alloc(0), 'x')).rejects.toThrow(/vazio/);
  });

  it('status e material sem certificado', async () => {
    expect(await h.certificates.status(tenant.id)).toEqual({ present: false });
    await expect(h.certificates.loadMaterial(tenant)).rejects.toThrow(/Nenhum certificado/);
  });

  it('avisa por e-mail quando faltam 30/15/7/3/1 dias', async () => {
    const { pfx, password } = generateTestPfx({
      notAfter: new Date(NOW.getTime() + 15 * 86_400_000 + 3_600_000),
    });
    await h.certificates.upload(tenant, pfx, password);
    expect(await h.certificates.warnExpiring()).toBe(1);
    expect(h.email.sent[0].subject).toMatch(/vence em 15 dia/);
    h.clock.advance(86_400_000);
    expect(await h.certificates.warnExpiring()).toBe(0);
  });
});

describe('ProductService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];
  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('CRUD com tributação por produto', async () => {
    const p = await h.products.create(tenant, {
      name: 'Consultoria',
      externalId: 'c1',
      taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900', issRateBps: 200 },
    });
    expect((await h.products.get(tenant.id, p.id)).taxProfile!.issRateBps).toBe(200);
    const updated = await h.products.update(tenant, p.id, { taxProfile: { issRateBps: 500 } });
    expect(updated.taxProfile).toMatchObject({
      nationalServiceCode: '170101',
      nbsCode: '114011900',
      issRateBps: 500,
    });
    expect((await h.products.list(tenant.id, {})).total).toBe(1);
    await h.products.deactivate(tenant.id, p.id);
    expect((await h.products.list(tenant.id, {})).total).toBe(0);
    expect((await h.products.list(tenant.id, { includeInactive: true })).total).toBe(1);
    await expect(h.products.get(tenant.id, 'nope')).rejects.toThrow(/não encontrado/);
  });

  it('impede externalId duplicado', async () => {
    await h.products.create(tenant, {
      name: 'A',
      externalId: 'x',
      taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900' },
    });
    await expect(
      h.products.create(tenant, {
        name: 'B',
        externalId: 'x',
        taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900' },
      })
    ).rejects.toThrow(/externalId x/);
    const b = await h.products.create(tenant, {
      name: 'B',
      externalId: 'y',
      taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900' },
    });
    await expect(h.products.update(tenant, b.id, { externalId: 'x' })).rejects.toThrow(
      /externalId x/
    );
  });

  it('busca códigos de serviço e consulta alíquota municipal com o certificado', async () => {
    const codes = h.products.searchServiceCodes('suporte informatica');
    expect(codes[0].nationalServiceCode).toBe('010701');
    const params = await h.products.municipalParams(tenant, '01.07.01');
    expect(params).toMatchObject({ issRateBps: 200, nationalServiceCode: '010701' });
    expect(h.municipal.calls[0]).toMatchObject({ cityCode: '3548708', code: '010701' });
    await expect(h.products.municipalParams(tenant, '12')).rejects.toThrow(/6 dígitos/);
  });
});

describe('dicas de rejeição', () => {
  it('mapeia erros comuns e tem fallback genérico', () => {
    expect(
      explainFiscalErrors([{ code: 'E0625', message: 'Alíquota informada indevidamente' }])[0]
    ).toMatch(/issRateBps/);
    expect(explainFiscalErrors([{ code: 'E9', message: 'xyz' }])[0]).toMatch(/retry_invoice/);
    expect(
      explainFiscalErrors([
        { code: 'E0116', message: 'Inscrição municipal do prestador não informada' },
      ])[0]
    ).toMatch(/exige a inscrição municipal/);
    expect(explainFiscalErrors([])).toEqual([]);
  });
});
