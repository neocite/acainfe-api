import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { makeTenant } from '../../../test/support/fixtures.js';
import { BillingCharge } from '../../domain/billing/billing.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import { BillingInvoicingService } from './billing-invoicing.service.js';

describe('BillingInvoicingService (nota mensal do uso do açaínfe)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let issuer: Tenant;
  let client: Tenant;
  let service: BillingInvoicingService;
  let n = 0;

  const charge = (
    tenantId: string,
    createdAt: string,
    extra: Partial<BillingCharge> = {}
  ): void => {
    n++;
    h.repos.billing.charges.set(`chg_${n}`, {
      id: `chg_${n}`,
      tenantId,
      invoiceId: `inv_${n}`,
      amountCents: 80,
      status: 'OPEN',
      createdAt: new Date(createdAt),
      ...extra,
    });
  };
  const build = (config = { issuerCnpj: '11.222.333/0001-81', productExternalId: 'acainfe-uso' }) =>
    new BillingInvoicingService({
      billing: h.repos.billing,
      tenants: h.repos.tenants,
      sales: h.sales,
      clock: h.clock,
      logger: h.logger,
      config,
    });

  beforeEach(async () => {
    h = buildAppHarness();
    issuer = (await h.onboard()).tenant;
    await h.products.create(issuer, {
      name: 'Prestação de serviço açaí nfe',
      externalId: 'acainfe-uso',
      taxProfile: {
        nationalServiceCode: '010501',
        nbsCode: '111032900',
        localServiceCode: '1.05/102313/1234',
      },
    });
    client = {
      ...makeTenant({
        cnpj: '11444777000161',
        legalName: 'XPTO Cursos LTDA',
        email: 'financeiro@xpto.com.br',
        address: {
          street: 'Rua A',
          number: '10',
          district: 'Centro',
          cityCode: '3550308',
          zipCode: '01001000',
        },
      }),
      id: 'client-xpto',
    };
    await h.repos.tenants.create(client);
    service = build();
  });

  it('emite uma nota por cliente com o total do mês anterior, contando pagas e em aberto', async () => {
    charge(client.id, '2026-09-01T03:00:00Z'); // 00h de 01/09 em Brasília
    charge(client.id, '2026-09-15T12:00:00Z', { status: 'PAID' });
    charge(client.id, '2026-10-01T02:59:00Z'); // 23h59 de 30/09 em Brasília
    charge(client.id, '2026-10-01T03:00:00Z'); // outubro: fica para o mês que vem
    charge(client.id, '2026-09-20T12:00:00Z', { status: 'WAIVED' });

    const result = await service.runMonthly();

    expect(result).toEqual({
      period: '2026-09',
      registered: 1,
      alreadyRegistered: 0,
      held: 0,
      failed: [],
    });
    const [invoice] = [...h.repos.invoices.items.values()];
    expect(invoice).toMatchObject({
      tenantId: issuer.id,
      amountCents: 240,
      serviceDescription: 'Uso do açaínfe (emissor de NFS-e): 3 nota(s) emitida(s) em 09/2026',
      taxProfile: expect.objectContaining({ nationalServiceCode: '010501' }),
      customer: expect.objectContaining({
        name: 'XPTO Cursos LTDA',
        email: 'financeiro@xpto.com.br',
      }),
    });
    expect(invoice.competenceDate).toEqual(new Date('2026-09-01T03:00:00Z'));
    const sale = [...h.repos.sales.items.values()][0];
    expect(sale).toMatchObject({
      source: 'ACAINFE_BILLING',
      externalId: `billing_2026-09_${client.id}`,
    });
  });

  it('rodar de novo não duplica a nota', async () => {
    charge(client.id, '2026-09-10T12:00:00Z');
    await service.runMonthly();
    const again = await service.runMonthly();
    expect(again).toMatchObject({ registered: 0, alreadyRegistered: 1 });
    expect(h.repos.invoices.items.size).toBe(1);
  });

  it('não emite nota da operadora para ela mesma nem de cobranças zeradas', async () => {
    charge(issuer.id, '2026-09-10T12:00:00Z');
    charge(client.id, '2026-09-10T12:00:00Z', { amountCents: 0 });
    const result = await service.runMonthly();
    expect(result).toMatchObject({ registered: 0, alreadyRegistered: 0, failed: [] });
    expect(h.repos.invoices.items.size).toBe(0);
  });

  it('produto sem tributação confirmada retém a venda em vez de perder', async () => {
    charge(client.id, '2026-09-10T12:00:00Z');
    const result = await build({
      issuerCnpj: issuer.cnpj,
      productExternalId: 'nao-cadastrado',
    }).runMonthly();
    expect(result).toMatchObject({ registered: 0, held: 1 });
    expect(h.repos.invoices.items.size).toBe(0);
  });

  it('fica desligado sem configuração; mês em andamento é recusado', async () => {
    charge(client.id, '2026-09-10T12:00:00Z');
    const off = build({ issuerCnpj: '', productExternalId: '' });
    expect(off.enabled).toBe(false);
    expect(await off.runMonthly()).toBeNull();
    await expect(off.invoicePeriod('2026-09')).rejects.toThrow(/desligada/);
    await expect(service.invoicePeriod('2026-10')).rejects.toThrow(/ainda não terminou/);
    await expect(service.invoicePeriod('2026-13')).rejects.toThrow(/AAAA-MM/);
  });
});
