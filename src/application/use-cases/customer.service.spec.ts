import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

describe('CustomerService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];
  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
  });

  it('CRUD de clientes', async () => {
    const c = await h.customers.create(tenant.id, {
      name: 'Maria',
      taxId: '529.982.247-25',
      email: 'MARIA@x.com',
    });
    expect(c).toMatchObject({ taxId: { kind: 'CPF', value: '52998224725' }, email: 'maria@x.com' });
    expect((await h.customers.update(tenant.id, c.id, { phone: '11999998888' })).phone).toBe(
      '5511999998888'
    );
    expect((await h.customers.list(tenant.id, { search: 'mar' })).total).toBe(1);
    await h.customers.delete(tenant.id, c.id);
    await expect(h.customers.get(tenant.id, c.id)).rejects.toThrow(/não encontrado/);
    await expect(h.customers.delete(tenant.id, c.id)).rejects.toThrow(/não encontrado/);
  });

  it('valida e impede duplicidade por CPF/CNPJ', async () => {
    await expect(h.customers.create(tenant.id, {})).rejects.toThrow(/ao menos/);
    await h.customers.create(tenant.id, { name: 'Maria', taxId: '52998224725' });
    await expect(
      h.customers.create(tenant.id, { name: 'Outra', taxId: '529.982.247-25' })
    ).rejects.toThrow(/Já existe/);
  });

  it('venda por customerId usa o cadastro (dados da venda prevalecem)', async () => {
    const c = await h.customers.create(tenant.id, {
      name: 'Maria',
      taxId: '52998224725',
      email: 'maria@x.com',
    });
    const r = await h.sales.register(tenant, {
      source: 'MCP',
      externalId: 's1',
      customerId: c.id,
      customer: { email: 'novo@x.com' },
      items: [{ productExternalId: 'sup', totalCents: 100 }],
    });
    expect(r.sale.customerId).toBe(c.id);
    expect(r.invoices[0].customer).toMatchObject({
      name: 'Maria',
      email: 'novo@x.com',
      taxId: { value: '52998224725' },
    });
    await expect(
      h.sales.register(tenant, {
        source: 'MCP',
        externalId: 's2',
        customerId: 'nope',
        items: [{ productExternalId: 'sup', totalCents: 1 }],
      })
    ).rejects.toThrow(/Cliente não encontrado/);
  });

  it('cadastra automaticamente clientes novos e reaproveita existentes', async () => {
    const first = await h.sales.register(tenant, {
      source: 'ABACATEPAY',
      externalId: 'b1',
      customer: { externalId: 'cust_1', name: 'João', email: 'joao@x.com' },
      items: [{ productExternalId: 'sup', totalCents: 100 }],
    });
    expect(first.sale.customerId).toBeDefined();
    const second = await h.sales.register(tenant, {
      source: 'ABACATEPAY',
      externalId: 'b2',
      customer: { email: 'joao@x.com', phone: '11988887777' },
      items: [{ productExternalId: 'sup', totalCents: 100 }],
    });
    expect(second.sale.customerId).toBe(first.sale.customerId);
    expect((await h.customers.get(tenant.id, first.sale.customerId!)).phone).toBe('5511988887777');
    expect(h.repos.customers.items.size).toBe(1);

    const anonymous = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'b3',
      items: [{ productExternalId: 'sup', totalCents: 1 }],
    });
    expect(anonymous.sale.customerId).toBeUndefined();
  });

  it('falha no cadastro automático não impede a venda', async () => {
    h.repos.customers.findMatch = async () => {
      throw new Error('mongo fora');
    };
    const r = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'x',
      customer: { email: 'a@b.com' },
      items: [{ productExternalId: 'sup', totalCents: 1 }],
    });
    expect(r.invoices).toHaveLength(1);
    expect(h.logger.entries.some((e) => /automaticamente/.test(e.message))).toBe(true);
  });
});

describe('logo e link de certificado', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];
  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('define logo por arquivo ou URL e usa no PDF', async () => {
    expect(await h.tenants.setLogo(tenant.id, { data: PNG })).toEqual({
      contentType: 'image/png',
      bytes: PNG.length,
    });
    h.fetcher.remote.set('https://cdn.x/logo.png', PNG);
    await h.tenants.setLogo(tenant.id, { url: 'https://cdn.x/logo.png' });
    expect(h.fetched).toEqual(['https://cdn.x/logo.png']);
    await expect(h.tenants.setLogo(tenant.id, { data: Buffer.from('GIF89a....') })).rejects.toThrow(
      /PNG ou JPEG/
    );
    await expect(h.tenants.setLogo(tenant.id, {})).rejects.toThrow(/Envie a imagem/);

    await h.products.create(tenant, {
      name: 'S',
      externalId: 's',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
    const r = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'l1',
      items: [{ productExternalId: 's', totalCents: 1 }],
    });
    await h.invoices.issue(r.invoices[0].id);
    await h.invoices.pdf(tenant, r.invoices[0].id);
    expect(h.renderer.calls.at(-1)!.withLogo).toBe(true);

    await h.tenants.removeLogo(tenant.id);
    expect(await h.tenants.getLogo(tenant.id)).toBeNull();
    await h.invoices.pdf(tenant, r.invoices[0].id);
    expect(h.renderer.calls.at(-1)!.withLogo).toBe(false);
  });

  it('gera link temporário de upload de certificado', () => {
    const link = h.certificates.createUploadLink(tenant.id);
    expect(link.url).toContain(tenant.id);
    expect(link.expiresAt.getTime() - h.clock.now().getTime()).toBe(30 * 60_000);
  });
});
