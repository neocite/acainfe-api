import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import {
  FiscalProvider,
  FiscalProviderResolver,
  FiscalProviderUnavailableError,
} from '../ports/fiscal-provider.js';

describe('Modo piloto (integração nova com a prefeitura)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, { name: 'Curso', externalId: 'c' });
    h.provider.requiresApproval = true;
  });

  const sale = async (externalId = 'v1') =>
    (
      await h.sales.register(tenant, {
        source: 'API',
        externalId,
        items: [{ productExternalId: 'c', totalCents: 3500 }],
      })
    ).invoices[0];

  it('nota espera aprovação; com a prévia conferida, aprova e emite', async () => {
    const pending = await sale();
    await h.invoices.issue(pending.id);
    expect(h.provider.calls).toEqual([]);
    const waiting = await h.invoices.get(tenant.id, pending.id);
    expect(waiting).toMatchObject({
      status: 'PENDING',
      lastErrors: [{ code: 'AWAITING_APPROVAL' }],
    });
    // Reprocessar não duplica o aviso.
    await h.invoices.issue(pending.id);
    expect(
      (await h.invoices.get(tenant.id, pending.id)).history.filter(
        (e) => e.event === 'AWAITING_APPROVAL'
      )
    ).toHaveLength(1);

    expect(await h.invoices.preview(tenant, pending.id)).toEqual({
      provider: 'FAKE',
      xml: `<Rps><Numero>${pending.dps.number}</Numero></Rps>`,
    });

    const approved = await h.invoices.approve(tenant, pending.id, 'MCP');
    expect(approved).toMatchObject({ approval: { via: 'MCP' }, lastErrors: [] });
    expect(h.scheduler.issues.map((i) => i.invoiceId)).toContain(pending.id);
    const issued = await h.invoices.issue(pending.id);
    expect(issued!.status).toBe('ISSUED');
    await expect(h.invoices.approve(tenant, pending.id, 'MCP')).rejects.toThrow(/ISSUED/);
  });

  it('aprovar uma nota rejeitada reenvia', async () => {
    const pending = await sale();
    h.provider.requiresApproval = false;
    h.provider.behaviours = ['REJECT'];
    await h.invoices.issue(pending.id);
    h.provider.requiresApproval = true;
    const approved = await h.invoices.approve(tenant, pending.id, 'MCP');
    expect(approved.status).toBe('PENDING');
    expect((await h.invoices.issue(pending.id))!.status).toBe('ISSUED');
  });

  it('consulta as notas já emitidas na prefeitura', async () => {
    h.provider.municipalNotes = [
      { number: '777', issuedAt: new Date('2026-10-01T12:00:00Z'), amountCents: 9700 },
    ];
    const items = await h.invoices.listMunicipal(tenant, {
      from: new Date('2026-10-01'),
      to: new Date('2026-10-31'),
    });
    expect(items[0]).toMatchObject({ number: '777', amountCents: 9700 });
  });

  describe('empresa que migrou para o Emissor Nacional', () => {
    const useSystems = (providers: FiscalProviderResolver) => {
      (h.invoices as unknown as { deps: { providers: FiscalProviderResolver } }).deps.providers =
        providers;
    };
    const range = { from: new Date('2026-10-15'), to: new Date('2026-11-03') };

    it('junta os dois sistemas; a cópia da mesma nota entra uma vez e o cancelamento vale', async () => {
      const issuedAt = new Date('2026-10-20T12:00:00Z');
      const nacional = {
        ...h.provider,
        name: 'NACIONAL',
        listIssued: async () => [
          { number: '48622', issuedAt, amountCents: 20204, cancelled: true },
          { number: '23', issuedAt, amountCents: 100 },
        ],
      } as unknown as FiscalProvider;
      h.provider.municipalNotes = [
        { number: '48622', issuedAt, amountCents: 20204 },
        { number: '48700', issuedAt, amountCents: 3500 },
      ];
      useSystems({ resolve: () => nacional, consultable: () => [nacional, h.provider] });

      const items = await h.invoices.listMunicipal(tenant, range);

      expect(items.map((n) => [n.number, n.system, n.cancelled])).toEqual([
        ['48622', 'NACIONAL', true],
        ['23', 'NACIONAL', false],
        ['48700', 'FAKE', false],
      ]);
    });

    it('um sistema fora do ar falha a consulta em vez de esconder as notas dele', async () => {
      const nacional = {
        ...h.provider,
        name: 'NACIONAL',
        listIssued: async () => {
          throw new FiscalProviderUnavailableError('ADN respondeu HTTP 429');
        },
      } as unknown as FiscalProvider;
      useSystems({ resolve: () => nacional, consultable: () => [h.provider, nacional] });
      await expect(h.invoices.listMunicipal(tenant, range)).rejects.toThrow(/429/);
    });

    it('procura a nota em cada sistema até achar', async () => {
      const nacional = {
        name: 'NACIONAL',
        getIssued: async () => null,
      } as unknown as FiscalProvider;
      const municipal = {
        name: 'GINFES',
        getIssued: async () => ({
          number: '48700',
          issuedAt: new Date(),
          amountCents: 3500,
          xml: '<x/>',
        }),
      } as unknown as FiscalProvider;
      useSystems({ resolve: () => nacional, consultable: () => [nacional, municipal] });
      await expect(h.invoices.getMunicipal(tenant, '48700')).resolves.toMatchObject({
        number: '48700',
      });
    });

    it('sem sistema que consulte, avisa com clareza', async () => {
      const semConsulta = { name: 'NACIONAL' } as unknown as FiscalProvider;
      useSystems({ resolve: () => semConsulta });
      expect(h.invoices.canListMunicipal(tenant)).toBe(false);
      await expect(h.invoices.listMunicipal(tenant, range)).rejects.toThrow(
        /ofereça esta consulta/
      );
    });
  });

  it('aprovação é escolha da empresa: sem a opção emite direto, com ela espera', async () => {
    h.provider.requiresApproval = false;
    const direct = await sale('direta');
    await h.invoices.issue(direct.id);
    expect((await h.invoices.get(tenant.id, direct.id)).status).toBe('ISSUED');

    await h.tenants.update(tenant.id, { requireInvoiceApproval: true });
    tenant = (await h.repos.tenants.findById(tenant.id))!;
    const held = await sale('com-aprovacao');
    await h.invoices.issue(held.id);
    expect(await h.invoices.get(tenant.id, held.id)).toMatchObject({
      status: 'PENDING',
      lastErrors: [{ code: 'AWAITING_APPROVAL' }],
    });
  });
});
