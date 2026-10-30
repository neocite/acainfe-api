import { unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { makeInvoice } from '../../../test/support/fixtures.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import {
  brtDayOfMonth,
  periodRange,
  previousPeriod,
} from '../../domain/accounting/accountant-report.js';
import { createTaxProfile } from '../../domain/product/tax-profile.js';
import { createAccountant } from '../../domain/tenant/tenant.js';
import { ACCOUNTANT_CSV_HEADER, buildAccountantCsv, lc116Item } from './accountant-csv.js';

/** Cabeçalho exatamente como exportado pelo eNotas ("Planilha Notas Emitidas"). */
const ENOTAS_HEADER =
  'Cliente_NomeRazaoSocial;Cliente_NomeFantasia;Cliente_Documento;Cliente_Email;Cliente_EnderecoCidadeCodigoIBGE;Cliente_EnderecoCidade;Cliente_EnderecoUF;Cliente_EnderecoCEP;Cliente_Endereco;Cliente_EnderecoNumero;Cliente_EnderecoComplemento;Cliente_EnderecoBairro;Cliente_EnderecoPais;Cliente_Telefone;Cliente_TipoPessoa;Cliente_InscricaoMunicipal;Cliente_InscricaoEstadual;NFe_ValorTotal;NFe_CNAE;NFe_CodigoServicoMunicipio;NFe_ItemListaServicoLC116;NFe_ValorCOFINS;NFe_ValorPIS;NFe_ValorCSLL;NFe_ValorINSS;NFe_ValorIR;NFe_ValorISS;NFe_AliquotaISS;NFe_ISSRetido;NFe_Discriminacao;NFe_NumeroPrefeitura;NFe_CodigoVerificacao;NFe_Situacao;NFe_DataAutorizacao;NFe_ChaveAcesso;NFe_CFOP;IDExterno';

describe('planilha do contador (layout eNotas)', () => {
  it('usa exatamente o cabeçalho do eNotas', () => {
    expect(ACCOUNTANT_CSV_HEADER.join(';')).toBe(ENOTAS_HEADER);
  });

  it('formata linhas como o eNotas: valor com vírgula, impostos com ponto, PF/PJ, cancelada, exterior', () => {
    const profile = createTaxProfile({
      nationalServiceCode: '080201',
      issRateBps: 201,
      localServiceCode: '8.02/103911/1551',
    });
    const issued = { ...sampleNfse('48714'), issuedAt: new Date('2026-10-17T22:43:49Z') };
    const csv = buildAccountantCsv([
      {
        invoice: makeInvoice({
          status: 'ISSUED',
          nfse: issued,
          amountCents: 19700,
          taxProfile: profile,
          serviceDescription: 'Filtripack Class;\nValor aprox',
          customer: {
            name: 'MARIA TESTE',
            taxId: { kind: 'CPF', value: '52998224725' },
            email: 'e@x.com',
            phone: '5566999796518',
          },
        }),
        saleExternalId: 'HP2787912131',
      },
      {
        invoice: makeInvoice({
          status: 'CANCELLED',
          nfse: { ...issued, number: '48707' },
          amountCents: 9700,
          taxProfile: profile,
          customer: { name: 'Loja Exemplo', taxId: { kind: 'CNPJ', value: '11444777000161' } },
        }),
      },
      {
        invoice: makeInvoice({
          status: 'ISSUED',
          nfse: { ...issued, number: '48720' },
          taxProfile: profile,
          customer: {
            name: 'Rejane',
            foreign: {
              countryCode: 'US',
              nif: 'DL',
              address: {
                street: 'Elms',
                number: '1',
                district: '',
                city: 'North Charleston',
                region: 'SC',
                postalCode: '29406',
              },
            },
          },
        }),
      },
    ]).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(ENOTAS_HEADER);
    const first = lines[1].split(';');
    expect(first.slice(0, 4)).toEqual(['Loja Exemplo', '', '11.444.777/0001-61', '']);
    expect(first[14]).toBe('PJ');
    expect(lines[1]).toContain(';Cancelada;');
    expect(lines[2]).toContain('MARIA TESTE;;529.982.247-25;e@x.com');
    expect(lines[2]).toContain(';66999796518;PF;');
    expect(lines[2]).toContain(
      ';197,00;;8.02/103911/1551;8.02;0.00;0.00;0.00;0.00;0.00;3.96;2.01;Não;"Filtripack Class;\nValor aprox";48714;;Autorizada;17-10-2026 19:43;'
    );
    expect(lines[2].endsWith(';HP2787912131')).toBe(true);
    expect(csv).toContain('Rejane;;DL;;;North Charleston;SC;29406;Elms;1;;;US;');
    expect(lc116Item('171401')).toBe('17.14');
  });
});

describe('períodos', () => {
  it('mês anterior e limites no fuso de Brasília', () => {
    expect(previousPeriod(new Date('2026-11-01T02:00:00Z'))).toBe('2026-09'); // 31/10 23h em Brasília
    expect(previousPeriod(new Date('2026-11-01T04:00:00Z'))).toBe('2026-10');
    expect(previousPeriod(new Date('2027-01-05T12:00:00Z'))).toBe('2026-12');
    expect(periodRange('2026-10')).toEqual({
      from: new Date('2026-10-01T03:00:00Z'),
      to: new Date('2026-11-01T03:00:00Z'),
    });
    expect(periodRange('2026-12').to).toEqual(new Date('2027-01-01T03:00:00Z'));
    expect(() => periodRange('2026-13')).toThrow(/AAAA-MM/);
    expect(brtDayOfMonth(new Date('2026-11-01T02:00:00Z'))).toBe(31);
    expect(() => createAccountant({})).toThrow(/contador/);
    expect(() => createAccountant({ email: 'c@x.com', dayOfMonth: 31 })).toThrow(/1 e 28/);
  });
});

describe('AccountantService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];

  const issue = async (externalId: string, totalCents: number) => {
    const r = await h.sales.register(tenant, {
      source: 'ABACATEPAY',
      externalId,
      customer: { name: 'Cliente', taxId: '52998224725', email: 'c@x.com' },
      items: [{ productExternalId: 'sup', totalCents }],
    });
    await h.invoices.issue(r.invoices[0].id);
    return r.invoices[0].id;
  };

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
  });

  it('monta o pacote do mês com PDFs, XMLs e planilha', async () => {
    await issue('a', 19700);
    await issue('b', 9700);
    const pkg = await h.accountant.buildPackage(
      (await h.repos.tenants.findById(tenant.id))!,
      '2026-10'
    );
    expect(pkg.invoices).toHaveLength(2);
    expect(pkg.totalCents).toBe(29400);
    const files = Object.keys(unzipSync(new Uint8Array(pkg.zip))).sort();
    expect(files).toEqual([
      'notas-2026-10.csv',
      'pdf/NFSe-1.pdf',
      'pdf/NFSe-2.pdf',
      'xml/NFSe-1.xml',
      'xml/NFSe-2.xml',
    ]);
    expect(pkg.zipName).toBe(`acainfe-notas-${tenant.cnpj}-2026-10.zip`);
    expect((await h.accountant.buildPackage(tenant, '2026-09')).invoices).toHaveLength(0);
  });

  it('envia por e-mail (planilha + ZIP + link) e WhatsApp (ZIP), avisa a empresa e registra', async () => {
    await issue('a', 19700);
    await expect(h.accountant.send(tenant, '2026-10', 'MANUAL')).rejects.toThrow(/Cadastre/);
    await h.accountant.setAccountant(tenant.id, {
      name: 'Contabilidade X',
      email: 'Contador@X.com',
      whatsapp: '(11) 98888-0000',
    });
    const fresh = (await h.repos.tenants.findById(tenant.id))!;
    const report = await h.accountant.send(fresh, '2026-10', 'MANUAL');
    expect(report).toMatchObject({
      status: 'SENT',
      invoiceCount: 1,
      totalCents: 19700,
      channels: ['EMAIL', 'WHATSAPP'],
    });

    const mail = h.email.sent.find((m) => m.to === 'contador@x.com')!;
    expect(mail.subject).toBe('Notas fiscais de outubro/2026 — Empresa Teste LTDA');
    expect(mail.attachments.map((a) => a.filename)).toEqual([
      'notas-2026-10.csv',
      `acainfe-notas-${tenant.cnpj}-2026-10.zip`,
    ]);
    expect(mail.text).toContain(`https://acainfe.test/pkg/${tenant.id}/2026-10`);
    const wa = h.whatsapp.sent.find((m) => m.phone === '5511988880000')!;
    expect(wa).toMatchObject({
      fileName: `acainfe-notas-${tenant.cnpj}-2026-10.zip`,
      fileUrl: `https://acainfe.test/pkg/${tenant.id}/2026-10`,
    });
    expect(
      h.email.sent.some((m) => m.to === tenant.email && /Enviamos ao seu contador/.test(m.subject))
    ).toBe(true);
    expect(await h.accountant.history(tenant.id)).toHaveLength(1);
  });

  it('job mensal: envia o mês anterior no dia configurado, uma única vez', async () => {
    await issue('a', 19700); // emitida em 18/10/2026
    await h.accountant.setAccountant(tenant.id, { email: 'contador@x.com', dayOfMonth: 2 });
    h.clock.current = new Date('2026-11-01T12:00:00Z');
    expect(await h.accountant.runMonthly()).toEqual({ sent: 0, failed: 0 }); // ainda dia 1
    h.clock.current = new Date('2026-11-02T12:00:00Z');
    expect(await h.accountant.runMonthly()).toEqual({ sent: 1, failed: 0 });
    expect(await h.accountant.runMonthly()).toEqual({ sent: 0, failed: 0 });
    expect(h.repos.accountantReports.items[0]).toMatchObject({
      period: '2026-10',
      trigger: 'SCHEDULE',
      invoiceCount: 1,
    });

    await h.accountant.setAccountant(tenant.id, { email: 'contador@x.com', monthlyReport: false });
    h.clock.current = new Date('2026-12-05T12:00:00Z');
    expect(await h.accountant.runMonthly()).toEqual({ sent: 0, failed: 0 });
  });

  it('falha nos canais é registrada para nova tentativa no dia seguinte', async () => {
    await h.accountant.setAccountant(tenant.id, { email: 'contador@x.com' });
    h.email.send = async () => {
      throw new Error('caixa cheia');
    };
    h.clock.current = new Date('2026-11-01T12:00:00Z');
    expect(await h.accountant.runMonthly()).toEqual({ sent: 0, failed: 1 });
    expect(h.repos.accountantReports.items[0]).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('caixa cheia'),
    });
    expect(await h.accountant.runMonthly()).toEqual({ sent: 0, failed: 1 }); // tenta de novo
    await h.accountant.setAccountant(tenant.id, null);
    expect((await h.repos.tenants.findById(tenant.id))!.accountant).toBeUndefined();
  });
});
