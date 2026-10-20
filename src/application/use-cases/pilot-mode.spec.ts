import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { Tenant } from '../../domain/tenant/tenant.js';

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
});
