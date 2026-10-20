import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { Tenant } from '../../domain/tenant/tenant.js';

describe('Ficha fiscal da empresa', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, { name: 'Curso de React', externalId: 'react' });
  });

  it('reúne empresa, emissão, tributação padrão, ISS, produtos e um resumo em texto', async () => {
    await h.tenants.update(tenant.id, {
      approximateTaxes: {
        rateBps: 1553,
        descriptionTemplate: 'Valor aprox dos tributos: R$ [ValorTributos]. Fonte: IBPT',
      },
    });
    tenant = (await h.repos.tenants.findById(tenant.id))!;
    const s = await h.fiscalSettings.get(tenant);
    expect(s.company).toMatchObject({
      cnpj: '11222333000181',
      municipalRegistration: '123456',
      taxRegimeLabel: 'Simples Nacional (ME/EPP)',
      simplesNacionalTaxRateBps: 600,
      simplesRateIsEstimate: false,
    });
    expect(s.emission).toMatchObject({
      system: 'NACIONAL',
      environment: 'PRODUCTION',
      series: '1',
    });
    expect(s.taxDefaults).toMatchObject({
      profileLabel: 'Infoprodutor',
      validated: true,
      nationalServiceCode: '080201',
      localServiceCode: '8.02/103911/1551',
      nbsCode: '122051900',
      issRetention: 'Não retido',
      ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
    });
    expect(s.issRate).toEqual({ bps: 201, source: 'SIMPLES_ESTIMATE' });
    expect(s.approximateTaxes).toMatchObject({ rateBps: 1553 });
    expect(s.products).toEqual([
      expect.objectContaining({ name: 'Curso de React', nbsCode: '122051900', warnings: [] }),
    ]);
    expect(s.text).toContain('CNPJ: 11.222.333/0001-81');
    expect(s.text).toContain('Código de tributação municipal: 8.02/103911/1551');
    expect(s.text).toContain('ISS: 2,01% (parcela do ISS no Simples, Anexo III)');
    expect(s.text).toContain('IBS/CBS: CST 000 · cClassTrib 000001 · indicador da operação 100301');
    expect(s.text).toContain('15,53% · texto na nota');
  });

  it('envia ao contador por e-mail e WhatsApp; sem contador, explica o que falta', async () => {
    await expect(h.fiscalSettings.sendToAccountant(tenant)).rejects.toThrow(/contador/);
    await h.repos.tenants.update({
      ...tenant,
      accountant: {
        name: 'Edmara',
        email: 'fiscal@contabilidade.com',
        whatsapp: '5511999990000',
        monthlyReport: true,
        dayOfMonth: 1,
      },
    });
    tenant = (await h.repos.tenants.findById(tenant.id))!;
    expect(await h.fiscalSettings.sendToAccountant(tenant)).toEqual({
      email: 'fiscal@contabilidade.com',
      whatsapp: '5511999990000',
    });
    const mail = h.email.sent.at(-1)!;
    expect(mail.subject).toContain('Configuração fiscal');
    expect(mail.text).toContain('Olá, Edmara!');
    expect(mail.text).toContain('FICHA FISCAL');
  });
});
