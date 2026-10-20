import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { sampleNfse } from '../../../test/support/in-memory.js';

describe('RefundService (estorno)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];

  const sale = async (externalId = 'p1') =>
    h.sales.register(tenant, {
      source: 'API',
      externalId,
      customer: { email: 'c@x.com' },
      items: [
        { productExternalId: 'sup', totalCents: 1000 },
        { productExternalId: 'curso', totalCents: 2000 },
      ],
    });
  const status = async (id: string) => (await h.repos.invoices.findByIdInternal(id))!;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
    await h.products.create(tenant, {
      name: 'Curso',
      externalId: 'curso',
      taxProfile: { nationalServiceCode: '080201' },
    });
  });

  it('cancela na prefeitura todas as notas emitidas da venda', async () => {
    const { sale: s, invoices } = await sale();
    for (const i of invoices) await h.invoices.issue(i.id);
    const result = await h.refunds.refundSale(tenant, { saleId: s.id }, { requestedBy: 'API' });
    expect(result.invoices.map((r) => r.outcome)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(result.sale.refund).toMatchObject({ reasonCode: '2', source: 'API' });
    for (const i of invoices) expect((await status(i.id)).status).toBe('CANCELLED');
    expect(h.provider.calls.filter((c) => c.startsWith('cancel'))).toHaveLength(2);

    // Idempotente: o gateway pode reenviar o evento de estorno.
    const again = await h.refunds.refundSale(tenant, { saleId: s.id }, { requestedBy: 'API' });
    expect(again.invoices.map((r) => r.outcome)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(h.provider.calls.filter((c) => c.startsWith('cancel'))).toHaveLength(2);
  });

  it('nota ainda não emitida é encerrada sem ir à prefeitura, e o job de emissão respeita o estorno', async () => {
    const { sale: s, invoices } = await sale();
    const result = await h.refunds.refundSale(
      tenant,
      { externalId: 'p1', source: 'API' },
      { requestedBy: 'API' }
    );
    expect(result.invoices.map((r) => r.outcome)).toEqual([
      'CANCELLED_BEFORE_ISSUE',
      'CANCELLED_BEFORE_ISSUE',
    ]);
    expect((await status(invoices[0].id)).cancellation).toMatchObject({ beforeIssue: true });
    await h.invoices.issue(invoices[0].id);
    expect(h.provider.calls).toEqual([]);
    expect(s.id).toBeDefined();
  });

  it('se a nota já pode ter chegado à prefeitura, consulta antes: encontrada → cancela', async () => {
    const { invoices } = await sale();
    h.provider.behaviours = ['DOWN'];
    await h.invoices.issue(invoices[0].id); // RETRYING, sentToProvider
    h.provider.existing = sampleNfse('55');
    const result = await h.refunds.refundSale(
      tenant,
      { externalId: 'p1', source: 'API' },
      { requestedBy: 'API' }
    );
    expect(result.invoices[0].outcome).toBe('CANCELLED');
    expect((await status(invoices[0].id)).nfse!.number).toBe('55');
    expect(h.provider.calls).toContain(`find:${invoices[0].id}`);
    expect(h.provider.calls).toContain(`cancel:${invoices[0].id}`);
  });

  it('prefeitura fora do ar: fica pendente e é concluído pela fila', async () => {
    const { invoices } = await sale();
    await h.invoices.issue(invoices[0].id);
    h.provider.down = true;
    const result = await h.refunds.refundSale(
      tenant,
      { externalId: 'p1', source: 'API' },
      { requestedBy: 'API' }
    );
    expect(result.invoices[0].outcome).toBe('PENDING');
    expect(h.scheduler.refunds.map((r) => r.invoiceId)).toContain(invoices[0].id);

    h.provider.down = false;
    expect((await h.refunds.settle(invoices[0].id)).outcome).toBe('CANCELLED');
  });

  it('cancelamento recusado (ex.: prazo) vira FAILED com os erros', async () => {
    const { invoices } = await sale();
    await h.invoices.issue(invoices[0].id);
    h.provider.cancelResult = {
      ok: false,
      errors: [{ code: 'E0840', message: 'Prazo de cancelamento expirado' }],
    };
    const result = await h.refunds.refundSale(
      tenant,
      { externalId: 'p1', source: 'API' },
      { requestedBy: 'API' }
    );
    expect(result.invoices[0]).toMatchObject({ outcome: 'FAILED', errors: [{ code: 'E0840' }] });
    const inv = await status(invoices[0].id);
    expect(inv.status).toBe('ISSUED');
    expect(inv.cancellationErrors![0].code).toBe('E0840');
    expect((await h.refunds.settle(invoices[0].id)).outcome).toBe('FAILED');
  });

  it('nota em processamento: reagenda para depois', async () => {
    const { invoices } = await sale();
    const inv = await status(invoices[0].id);
    await h.repos.invoices.update({ ...inv, status: 'PROCESSING' });
    const result = await h.refunds.refundSale(
      tenant,
      { externalId: 'p1', source: 'API' },
      { requestedBy: 'API' }
    );
    expect(result.invoices[0].outcome).toBe('PENDING');
  });

  it('estornada durante a emissão: cancela em seguida e não envia ao cliente', async () => {
    const { sale: s, invoices } = await sale();
    const original = h.provider.issue.bind(h.provider);
    h.provider.issue = async (...args) => {
      await h.repos.sales.setRefund(s.id, {
        requestedAt: new Date(),
        reasonCode: '2',
        reason: 'Estorno durante emissão',
        source: 'API',
      });
      return original(...args);
    };
    await h.invoices.issue(invoices[0].id);
    expect(h.scheduler.deliveries).toHaveLength(0);
    expect(h.scheduler.refunds.map((r) => r.invoiceId)).toContain(invoices[0].id);
    expect((await h.refunds.settle(invoices[0].id)).outcome).toBe('CANCELLED');
    await h.invoices.deliver(invoices[0].id, 'EMAIL');
    expect(h.email.sent).toHaveLength(0);
  });

  it('valida venda e justificativa', async () => {
    await expect(
      h.refunds.refundSale(tenant, { saleId: 'nope' }, { requestedBy: 'API' })
    ).rejects.toThrow(/não encontrad/);
    await expect(h.refunds.refundSale(tenant, {}, { requestedBy: 'API' })).rejects.toThrow(
      /não encontrad/
    );
    const { sale: s } = await sale();
    await expect(
      h.refunds.refundSale(tenant, { saleId: s.id }, { requestedBy: 'API', reason: 'curta' })
    ).rejects.toThrow(/15 a 255/);
    await expect(h.refunds.settle('nope')).rejects.toThrow(/não encontrad/);
  });

  it('settle sem estorno solicitado não faz nada', async () => {
    const { invoices } = await sale();
    expect((await h.refunds.settle(invoices[0].id)).outcome).toBe('PENDING');
    expect(h.provider.calls).toEqual([]);
  });
});
