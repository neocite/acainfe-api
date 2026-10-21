import { createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeInvoice, makeTenant } from '../../../../../test/support/fixtures.js';
import { generateTestPfx } from '../../../../../test/support/test-certificate.js';
import { validateAgainstXsd } from '../../../../../test/support/xsd.js';
import { FiscalProviderUnavailableError } from '../../../../application/ports/fiscal-provider.js';
import { FISCAL_PROFILES } from '../../../../domain/product/fiscal-profiles.js';
import { createTaxProfile } from '../../../../domain/product/tax-profile.js';
import { openPfx } from '../../crypto/pfx.js';
import { signEnvelopedSha1 } from '../shared/xmldsig.js';
import { PaulistanaFiscalProvider, SP_VERIFICATION_URL } from './paulistana-fiscal-provider.js';
import { parseEnvioRps, parseNFeList, summarizePaulistanaXml } from './paulistana-parser.js';
import { PaulistanaOperation, soapAction, soapEnvelope, soapReturn } from './paulistana-soap.js';
import {
  bpsToTrimmedFraction,
  buildPedidoCancelamento,
  buildPedidoConsultaEmitidas,
  buildPedidoConsultaNFe,
  buildPedidoEnvioRps,
  cancelSignatureString,
  paulistanaMissingFields,
  rpsSignatureString,
} from './paulistana-xml.js';

const cert = generateTestPfx();
const pfx = openPfx(cert.pfx, cert.password);
const material = { pfx: cert.pfx, password: cert.password };

const tenant = makeTenant({
  cityCode: '3550308',
  municipalRegistration: '1.234.567-8',
  environment: 'PRODUCTION',
  approximateTaxes: {
    rateBps: 1553,
    source: 'IBPT',
    descriptionTemplate: 'Valor aprox dos tributos: R$ [ValorTributos]. Fonte: IBPT',
  },
});
const taxProfile = createTaxProfile({
  ...FISCAL_PROFILES.INFOPRODUCER.taxProfile,
  localServiceCode: FISCAL_PROFILES.INFOPRODUCER.localServiceCodes!['3550308'],
  issRateBps: 500,
});
const invoice = makeInvoice({
  taxProfile,
  amountCents: 9700,
  serviceDescription: 'Mentoria 🚀 em grupo\nTurma de outubro',
  dps: { series: 'A', number: 42, id: 'x' },
  competenceDate: new Date('2026-10-21T15:00:00Z'),
  customer: {
    taxId: { kind: 'CPF', value: '12345678909' },
    name: 'Ana Souza',
    email: 'ana@exemplo.com',
    address: {
      street: 'Av. Paulista',
      number: '100',
      complement: 'Cj 35',
      district: 'Bela Vista',
      cityCode: '3550308',
      zipCode: '01310-100',
    },
  },
});

const sign = (xml: string, root: string) =>
  signEnvelopedSha1(xml, pfx, { reference: root, placement: 'append', byId: false });
const validate = (xml: string, schema: string) => validateAgainstXsd(xml, schema, 'paulistana');

describe('NFS-e Paulistana: montagem do XML (leiaute 1)', () => {
  it('a string da assinatura do RPS tem 86 posições, no formato do manual', () => {
    const s = rpsSignatureString(invoice, tenant);
    expect(s).toBe(
      '12345678A    00000000004220261021TNN00000000000970000000000000000005762100012345678909'
    );
    expect(s).toHaveLength(86);
    // Sem tomador identificado: indicador 3 e 14 zeros.
    const anonymous = rpsSignatureString(
      makeInvoice({ ...invoice, customer: { name: 'X' } }),
      tenant
    );
    expect(anonymous.slice(-15)).toBe('3' + '0'.repeat(14));
  });

  it('RPS válido no XSD oficial, com assinatura do RPS verificável e carga tributária', async () => {
    const xml = sign(buildPedidoEnvioRps(invoice, tenant, pfx), 'PedidoEnvioRPS');
    expect(await validate(xml, 'PedidoEnvioRPS_v01.xsd')).toEqual([]);
    expect(xml).toContain('<CodigoServico>05762</CodigoServico>');
    expect(xml).toContain('<AliquotaServicos>0.05</AliquotaServicos>');
    expect(xml).toContain('<ValorServicos>97.00</ValorServicos>');
    expect(xml).toContain('<DataEmissao>2026-10-21</DataEmissao>');
    expect(xml).toContain('<CEP>1310100</CEP>');
    expect(xml).toContain('<PercentualCargaTributaria>0.1553</PercentualCargaTributaria>');
    // Latin-1 e sem quebra de linha: emoji removido, \n vira " | ".
    expect(xml).toMatch(/<Discriminacao>Mentoria em grupo \| Turma de outubro/);

    const signature = /<Assinatura>([^<]+)<\/Assinatura>/.exec(xml)![1];
    const ok = createVerify('RSA-SHA1')
      .update(rpsSignatureString(invoice, tenant), 'ascii')
      .verify(pfx.certificatePem, signature, 'base64');
    expect(ok).toBe(true);
  });

  it('cliente PJ sem endereço, sem CCM ou sem código de SP: pendências claras', () => {
    const pj = makeInvoice({
      ...invoice,
      customer: { taxId: { kind: 'CNPJ', value: '11444777000161' }, name: 'XPTO' },
      taxProfile: createTaxProfile({ ...taxProfile, localServiceCode: '8.02/103911/1551' }),
    });
    const missing = paulistanaMissingFields(pj, { ...tenant, municipalRegistration: undefined });
    expect(missing.join(' ')).toMatch(/CCM/);
    expect(missing.join(' ')).toMatch(/5 dígitos/);
    expect(missing.join(' ')).toMatch(/Endereço do tomador/);
    expect(paulistanaMissingFields(invoice, tenant)).toEqual([]);
  });

  it('consultas e cancelamento válidos no XSD', async () => {
    expect(
      await validate(
        sign(
          buildPedidoConsultaNFe(tenant, { rps: { series: 'A', number: '42' } }),
          'PedidoConsultaNFe'
        ),
        'PedidoConsultaNFe_v01.xsd'
      )
    ).toEqual([]);
    expect(
      await validate(
        sign(buildPedidoConsultaNFe(tenant, { nfse: '17943' }), 'PedidoConsultaNFe'),
        'PedidoConsultaNFe_v01.xsd'
      )
    ).toEqual([]);
    expect(
      await validate(
        sign(
          buildPedidoConsultaEmitidas(
            tenant,
            { from: new Date('2026-10-01T03:00:00Z'), to: new Date('2026-10-21T15:00:00Z') },
            1
          ),
          'PedidoConsultaNFePeriodo'
        ),
        'PedidoConsultaNFePeriodo_v01.xsd'
      )
    ).toEqual([]);
    expect(cancelSignatureString(tenant, '17945')).toBe('12345678000000017945');
    expect(
      await validate(
        sign(buildPedidoCancelamento(tenant, '17945', pfx), 'PedidoCancelamentoNFe'),
        'PedidoCancelamentoNFe_v01.xsd'
      )
    ).toEqual([]);
  });

  it('alíquota como fração sem zeros à direita', () => {
    expect(bpsToTrimmedFraction(500)).toBe('0.05');
    expect(bpsToTrimmedFraction(201)).toBe('0.0201');
    expect(bpsToTrimmedFraction(290)).toBe('0.029');
    expect(() => bpsToTrimmedFraction(10_000)).toThrow();
  });

  it('SOAP 1.1: mensagem escapada, SOAPAction da prefeitura e RetornoXML desescapado', () => {
    const envelope = soapEnvelope('EnvioRPS', '<PedidoEnvioRPS/>');
    expect(envelope).toContain('<EnvioRPSRequest xmlns="http://www.prefeitura.sp.gov.br/nfe">');
    expect(envelope).toContain(
      '<VersaoSchema>1</VersaoSchema><MensagemXML>&lt;PedidoEnvioRPS/&gt;</MensagemXML>'
    );
    expect(soapAction('CancelamentoNFe')).toBe(
      'http://www.prefeitura.sp.gov.br/nfe/ws/cancelamentoNFe'
    );
    expect(
      soapReturn(
        '<soap:Body><EnvioRPSResponse><RetornoXML>&lt;a&gt;1&lt;/a&gt;</RetornoXML></EnvioRPSResponse></soap:Body>'
      )
    ).toBe('<a>1</a>');
    expect(() => soapReturn('<soap:Fault><faultstring>x</faultstring></soap:Fault>')).toThrow(
      FiscalProviderUnavailableError
    );
  });
});

const retornoEnvio = (number = '17943') =>
  `<RetornoEnvioRPS xmlns="http://www.prefeitura.sp.gov.br/nfe"><Cabecalho Versao="1" xmlns=""><Sucesso>true</Sucesso></Cabecalho><ChaveNFeRPS xmlns=""><ChaveNFe><InscricaoPrestador>12345678</InscricaoPrestador><NumeroNFe>${number}</NumeroNFe><CodigoVerificacao>PH5GL6XU</CodigoVerificacao></ChaveNFe><ChaveRPS><InscricaoPrestador>12345678</InscricaoPrestador><SerieRPS>A</SerieRPS><NumeroRPS>42</NumeroRPS></ChaveRPS></ChaveNFeRPS></RetornoEnvioRPS>`;
const nfe = (number: string, status = 'N') =>
  `<NFe xmlns=""><ChaveNFe><InscricaoPrestador>12345678</InscricaoPrestador><NumeroNFe>${number}</NumeroNFe><CodigoVerificacao>PH5GL6XU</CodigoVerificacao></ChaveNFe><DataEmissaoNFe>2026-10-21T12:00:05</DataEmissaoNFe><DataFatoGeradorNFe>2026-10-21T00:00:00</DataFatoGeradorNFe><ChaveRPS><InscricaoPrestador>12345678</InscricaoPrestador><SerieRPS>A</SerieRPS><NumeroRPS>42</NumeroRPS></ChaveRPS><CPFCNPJPrestador><CNPJ>11222333000181</CNPJ></CPFCNPJPrestador><RazaoSocialPrestador>EMPRESA TESTE</RazaoSocialPrestador><EnderecoPrestador><Logradouro>PAULISTA</Logradouro><NumeroEndereco>1</NumeroEndereco><Cidade>3550308</Cidade></EnderecoPrestador><StatusNFe>${status}</StatusNFe><TributacaoNFe>T</TributacaoNFe><OpcaoSimples>4</OpcaoSimples><ValorServicos>97</ValorServicos><CodigoServico>5762</CodigoServico><AliquotaServicos>0.05</AliquotaServicos><ValorISS>0</ValorISS><ValorCredito>0</ValorCredito><ISSRetido>false</ISSRetido><CPFCNPJTomador><CPF>12345678909</CPF></CPFCNPJTomador><RazaoSocialTomador>Ana Souza</RazaoSocialTomador><Discriminacao>Mentoria</Discriminacao></NFe>`;
const consulta = (...nfes: string[]) =>
  `<RetornoConsulta xmlns="http://www.prefeitura.sp.gov.br/nfe"><Cabecalho Versao="1" xmlns=""><Sucesso>true</Sucesso></Cabecalho>${nfes.join('')}</RetornoConsulta>`;
const erro = (codigo: string, descricao: string) =>
  `<RetornoConsulta xmlns="http://www.prefeitura.sp.gov.br/nfe"><Cabecalho Versao="1" xmlns=""><Sucesso>false</Sucesso></Cabecalho><Erro xmlns=""><Codigo>${codigo}</Codigo><Descricao>${descricao}</Descricao></Erro></RetornoConsulta>`;

function fakeTransport(responder: (op: PaulistanaOperation, message: string) => string) {
  const calls: { op: PaulistanaOperation; message: string }[] = [];
  return {
    calls,
    async call(_url: string, op: PaulistanaOperation, message: string) {
      calls.push({ op, message });
      return responder(op, message);
    },
  };
}

describe('PaulistanaFiscalProvider', () => {
  const config = { url: 'https://sp.test/lotenfe.asmx', pilot: true };

  it('EnvioRPS devolve a nota na hora; busca a nota completa para o PDF', async () => {
    const t = fakeTransport((op) => (op === 'EnvioRPS' ? retornoEnvio() : consulta(nfe('17943'))));
    const provider = new PaulistanaFiscalProvider(t, config);
    expect(provider.requiresApproval).toBe(true);
    const out = await provider.issue(invoice, tenant, material);
    expect(out).toMatchObject({
      kind: 'ISSUED',
      nfse: {
        provider: 'PAULISTANA',
        number: '17943',
        accessKey: 'PH5GL6XU',
        amountCents: 9700,
        verificationUrl: SP_VERIFICATION_URL({
          number: '17943',
          verificationCode: 'PH5GL6XU',
          ccm: '12345678',
        }),
      },
    });
    expect(t.calls.map((c) => c.op)).toEqual(['EnvioRPS', 'ConsultaNFe']);
    expect(t.calls[0].message).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(summarizePaulistanaXml(out.kind === 'ISSUED' ? out.nfse.xml : '')).toMatchObject({
      issuerName: 'EMPRESA TESTE',
      issRateText: '5.00',
    });
  });

  it('erros viram rejeição; dados faltando nem chegam à prefeitura; sem homologação', async () => {
    const t = fakeTransport(() =>
      erro('1206', 'Assinatura do RPS incorreta')
        .replace('RetornoConsulta', 'RetornoEnvioRPS')
        .replace('RetornoConsulta', 'RetornoEnvioRPS')
    );
    const provider = new PaulistanaFiscalProvider(t, config);
    expect(await provider.issue(invoice, tenant, material)).toEqual({
      kind: 'REJECTED',
      errors: [{ code: '1206', message: 'Assinatura do RPS incorreta' }],
    });
    const homolog = await provider.issue(
      invoice,
      { ...tenant, environment: 'HOMOLOGATION' },
      material
    );
    expect(homolog).toMatchObject({ kind: 'REJECTED', errors: [{ code: 'PAULISTANA_DADOS' }] });
    expect(t.calls).toHaveLength(1);
  });

  it('consulta pelo RPS: encontrada, não encontrada (1106) ou falha da prefeitura', async () => {
    let reply = consulta(nfe('17943'));
    const provider = new PaulistanaFiscalProvider(
      fakeTransport(() => reply),
      config
    );
    expect(await provider.findByDpsId(invoice, tenant, material)).toMatchObject({
      number: '17943',
    });
    reply = erro('1106', 'NF-e não encontrada');
    expect(await provider.findByDpsId(invoice, tenant, material)).toBeNull();
    reply = erro('1100', 'CNPJ do certificado difere do remetente');
    await expect(provider.findByDpsId(invoice, tenant, material)).rejects.toThrow(
      FiscalProviderUnavailableError
    );
  });

  it('cancela; nota já cancelada (alerta 1301) também conta como cancelada', async () => {
    const issued = {
      ...invoice,
      nfse: {
        provider: 'PAULISTANA' as const,
        number: '17943',
        accessKey: 'X',
        issuedAt: new Date(),
        xml: '',
        verificationUrl: '',
      },
    };
    let reply =
      '<RetornoCancelamentoNFe><Cabecalho xmlns=""><Sucesso>true</Sucesso></Cabecalho></RetornoCancelamentoNFe>';
    const t = fakeTransport(() => reply);
    const provider = new PaulistanaFiscalProvider(t, config);
    expect(await provider.cancel(issued, tenant, material)).toEqual({ ok: true });
    expect(t.calls[0].message).toContain('<AssinaturaCancelamento>');
    reply =
      '<RetornoCancelamentoNFe><Cabecalho xmlns=""><Sucesso>false</Sucesso></Cabecalho><Alerta xmlns=""><Codigo>1301</Codigo><Descricao>NF-e já cancelada</Descricao></Alerta></RetornoCancelamentoNFe>';
    expect(await provider.cancel(issued, tenant, material)).toEqual({ ok: true });
    reply =
      '<RetornoCancelamentoNFe><Cabecalho xmlns=""><Sucesso>false</Sucesso></Cabecalho><Erro xmlns=""><Codigo>1306</Codigo><Descricao>Só cancela nota gerada via WS</Descricao></Erro></RetornoCancelamentoNFe>';
    expect(await provider.cancel(issued, tenant, material)).toMatchObject({
      ok: false,
      errors: [{ code: '1306' }],
    });
  });

  it('lista as emitidas em janelas de até 31 dias e páginas de 50', async () => {
    const page = (n: number) =>
      consulta(...Array.from({ length: n }, (_, i) => nfe(String(1000 + i))));
    const t = fakeTransport((_op, message) =>
      message.includes('<NumeroPagina>1</NumeroPagina>') && message.includes('<dtInicio>2026-09-01')
        ? page(50)
        : message.includes('<NumeroPagina>2</NumeroPagina>')
          ? page(3)
          : page(1)
    );
    const provider = new PaulistanaFiscalProvider(t, config);
    const list = await provider.listIssued(tenant, material, {
      from: new Date('2026-09-01T03:00:00Z'),
      to: new Date('2026-10-21T15:00:00Z'),
    });
    // Janela 1 (setembro): 50 + 3; janela 2 (outubro): 1.
    expect(list).toHaveLength(54);
    expect(t.calls).toHaveLength(3);
    expect(list[0]).toMatchObject({
      amountCents: 9700,
      issRateBps: 500,
      customerDocument: '12345678909',
    });
  });

  it('parser: retorno de sucesso e lista de notas', () => {
    expect(parseEnvioRps(retornoEnvio('5'))).toMatchObject({
      number: '5',
      verificationCode: 'PH5GL6XU',
    });
    expect(parseNFeList(consulta(nfe('1', 'C')))[0]).toMatchObject({ cancelled: true });
  });
});
