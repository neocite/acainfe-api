import { readFileSync } from 'node:fs';
import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { makeInvoice, makeTenant, NOW } from '../../../../../test/support/fixtures.js';
import { generateTestPfx } from '../../../../../test/support/test-certificate.js';
import { validateAgainstXsd } from '../../../../../test/support/xsd.js';
import { FiscalProviderUnavailableError } from '../../../../application/ports/fiscal-provider.js';
import { FISCAL_PROFILES } from '../../../../domain/product/fiscal-profiles.js';
import { createTaxProfile } from '../../../../domain/product/tax-profile.js';
import { openPfx } from '../../crypto/pfx.js';
import { GinfesFiscalProvider, SBC_VERIFICATION_URL } from './ginfes-fiscal-provider.js';
import { decimalToCents, fractionToBps, parseCompNfseList } from './ginfes-parser.js';
import { signCancelV3, signLote, signRoot } from './ginfes-signer.js';
import { soapEnvelope, soapReturn } from './ginfes-soap.js';
import {
  bpsToFraction,
  buildCancelarV2,
  buildCancelarV3,
  buildConsultarLote,
  buildConsultarNfse,
  buildConsultarNfseRps,
  buildConsultarSituacaoLote,
  buildEnviarLoteRps,
  ginfesDateTime,
  itemListaServico,
  regimeEspecialTributacao,
} from './ginfes-xml.js';

const cert = generateTestPfx();
const pfx = openPfx(cert.pfx, cert.password);
const material = { pfx: cert.pfx, password: cert.password };

const tenant = makeTenant({ cityCode: '3548708', municipalRegistration: '123456' });
const taxProfile = createTaxProfile({
  ...FISCAL_PROFILES.INFOPRODUCER.taxProfile,
  issRateBps: 201,
});
const invoice = makeInvoice({
  taxProfile,
  amountCents: 3500,
  serviceDescription: 'Venda espaço Jely',
  dps: { series: '900', number: 2, id: 'x' },
  customer: {
    name: 'Bruno Lima',
    address: {
      street: 'R. Luiz Pereira Barreto',
      number: '1248',
      district: 'Centro',
      cityCode: '3502804',
      zipCode: '16015445',
    },
  },
});

/**
 * XSD 3.01 do Ginfes com a ordem de tcValores da produção de SBC (trib/IBSCBS após IssRetido),
 * derivada da NFS-e 48714 autorizada (eNotas). Ver o comentário no tipos_v03.xsd.
 */
const rtcXsd = (xml: string) =>
  validateAgainstXsd(xml, 'servico_enviar_lote_rps_envio_v03.xsd', 'ginfes/sbc');

/** Nomes dos filhos de Valores, em ordem. */
const valoresOrder = (xml: string): string[] => {
  const valores = /<(?:\w+:)?Valores>([\s\S]*?)<\/(?:\w+:)?Valores>/.exec(xml)![1];
  const names: string[] = [];
  let depth = 0;
  for (const m of valores.matchAll(/<(\/?)(?:\w+:)?(\w+)[^>]*?(\/?)>/g)) {
    if (m[1]) depth--;
    else {
      if (depth === 0) names.push(m[2]);
      if (!m[3]) depth++;
    }
  }
  return names;
};

const bothXsdSets = async (xml: string, schema: string) => ({
  sped: await validateAgainstXsd(xml, schema, 'ginfes/sped'),
  acbr: await validateAgainstXsd(xml, schema, 'ginfes/acbr'),
});

const verify = (xml: string): boolean => {
  const sig = new SignedXml({ publicCert: pfx.certificatePem });
  const doc = xml.match(/<Signature[\s\S]*?<\/Signature>/)![0];
  sig.loadSignature(doc);
  return sig.checkSignature(xml);
};

const compNfse = (opts: { number?: string; amount?: string; doc?: string } = {}) =>
  `<ns4:CompNfse xmlns:ns4="http://www.ginfes.com.br/tipos_v03.xsd"><ns4:Nfse><ns4:InfNfse><ns4:Numero>${opts.number ?? '4521'}</ns4:Numero><ns4:CodigoVerificacao>AB12CD34E</ns4:CodigoVerificacao><ns4:DataEmissao>2026-10-19T10:15:00</ns4:DataEmissao><ns4:IdentificacaoRps><ns4:Numero>2</ns4:Numero><ns4:Serie>900</ns4:Serie><ns4:Tipo>1</ns4:Tipo></ns4:IdentificacaoRps><ns4:Servico><ns4:Valores><ns4:ValorServicos>${opts.amount ?? '35.00'}</ns4:ValorServicos><ns4:Aliquota>0.0201</ns4:Aliquota></ns4:Valores><ns4:ItemListaServico>08.02</ns4:ItemListaServico><ns4:CodigoTributacaoMunicipio>8.02/103911/1551</ns4:CodigoTributacaoMunicipio><ns4:Discriminacao>Venda espaço Jely</ns4:Discriminacao></ns4:Servico><ns4:TomadorServico>${opts.doc ? `<ns4:IdentificacaoTomador><ns4:CpfCnpj><ns4:Cpf>${opts.doc}</ns4:Cpf></ns4:CpfCnpj></ns4:IdentificacaoTomador>` : ''}<ns4:RazaoSocial>Bruno Lima</ns4:RazaoSocial></ns4:TomadorServico></ns4:InfNfse></ns4:Nfse></ns4:CompNfse>`;

const errorReply = (root: string, code: string, msg: string) =>
  `<ns3:${root} xmlns:ns3="x" xmlns:ns4="y"><ns3:ListaMensagemRetorno><ns4:MensagemRetorno><ns4:Codigo>${code}</ns4:Codigo><ns4:Mensagem>${msg}</ns4:Mensagem></ns4:MensagemRetorno></ns3:ListaMensagemRetorno></ns3:${root}>`;

describe('Ginfes v3: montagem do XML', () => {
  it('lote com um RPS de infoprodutor no Simples, válido no XSD 3.01 (reforma) e assinado', async () => {
    const xml = buildEnviarLoteRps(invoice, tenant, NOW);
    expect(xml).toContain('<tipos:Aliquota>0.0201</tipos:Aliquota>');
    // Simples sem retenção: ISS pago no DAS, ValorIss 0,00 na nota (E208 em SBC); alíquota informada.
    expect(xml).toContain(
      '<tipos:ValorIss>0.00</tipos:ValorIss><tipos:BaseCalculo>35.00</tipos:BaseCalculo>'
    );
    // Sem ValorIssRetido/ValorDeducoes/OutrasRetencoes zerados (E197 em SBC).
    expect(xml).not.toMatch(/ValorIssRetido|ValorDeducoes|OutrasRetencoes/);
    expect(xml).toContain('<tipos:ItemListaServico>08.02</tipos:ItemListaServico>');
    expect(xml).toContain(
      '<tipos:CodigoTributacaoMunicipio>8.02/103911/1551</tipos:CodigoTributacaoMunicipio>'
    );
    // Exigido por SBC para optantes do Simples (E166): 6 = ME/EPP.
    expect(xml).toContain(
      '<tipos:NaturezaOperacao>1</tipos:NaturezaOperacao><tipos:RegimeEspecialTributacao>6</tipos:RegimeEspecialTributacao><tipos:OptanteSimplesNacional>1</tipos:OptanteSimplesNacional>'
    );
    expect(xml).toContain('<tipos:DataEmissao>2026-10-18T10:00:00</tipos:DataEmissao>');
    expect(xml).toContain('<tipos:Numero>2</tipos:Numero><tipos:Serie>900</tipos:Serie>');
    // Sem CPF: nome e endereço, sem IdentificacaoTomador.
    expect(xml).not.toContain('IdentificacaoTomador');
    expect(xml).toContain('<tipos:Uf>SP</tipos:Uf><tipos:Cep>16015445</tipos:Cep>');
    // Reforma (layout 3.01): NBS, percentual aproximado do Simples e grupo IBS/CBS como no eNotas.
    expect(xml).toContain(
      '<tipos:CodigoMunicipio>3548708</tipos:CodigoMunicipio><tipos:CodigoNbs>122051900</tipos:CodigoNbs>'
    );
    // Igual à NFS-e 48714 autorizada (eNotas): trib/IBSCBS logo após IssRetido, pTotTrib zerado,
    // incidência no município do prestador e vBC preenchido.
    expect(xml).toContain(
      '<tipos:IssRetido>2</tipos:IssRetido><tipos:trib><tipos:totTrib><tipos:pTotTrib><tipos:pTotTribFed>0</tipos:pTotTribFed><tipos:pTotTribEst>0</tipos:pTotTribEst><tipos:pTotTribMun>0</tipos:pTotTribMun></tipos:pTotTrib></tipos:totTrib></tipos:trib>'
    );
    expect(xml).toContain(
      '<tipos:IBSCBS><tipos:finNFSe>0</tipos:finNFSe><tipos:indFinal>1</tipos:indFinal><tipos:cIndOp>100301</tipos:cIndOp><tipos:indDest>0</tipos:indDest><tipos:valores><tipos:trib><tipos:gIBSCBS><tipos:CST>000</tipos:CST><tipos:cClassTrib>000001</tipos:cClassTrib></tipos:gIBSCBS></tipos:trib><tipos:cLocalidadeIncid>3548708</tipos:cLocalidadeIncid><tipos:pRedutor>0</tipos:pRedutor><tipos:vBC>35.00</tipos:vBC></tipos:valores></tipos:IBSCBS><tipos:ValorIss>0.00</tipos:ValorIss>'
    );
    // Mesma ordem relativa dos campos de Valores da nota autorizada.
    const golden = valoresOrder(
      readFileSync(
        new URL(
          '../../../../../test/fixtures/ginfes/enotas-48714-anonimizada.xml',
          import.meta.url
        ),
        'utf8'
      )
    );
    const ours = valoresOrder(xml);
    expect(ours.every((n) => golden.includes(n))).toBe(true);
    expect(ours).toEqual(golden.filter((n) => ours.includes(n)));
    // Sem PIS/COFINS em Valores (SBC 3.01: aparecem retidos em dobro).
    expect(xml).not.toMatch(/ValorPis|ValorCofins/);

    const signed = signLote(xml, pfx);
    expect(signed).toMatch(
      /<\/LoteRps><Signature xmlns="http:\/\/www.w3.org\/2000\/09\/xmldsig#">/
    );
    expect(signed).toContain(`URI="#Lote_${String(NOW.getTime()).slice(-13)}"`);
    expect(signed).toContain('rsa-sha1');
    expect(verify(signed)).toBe(true);
    expect(await rtcXsd(signed)).toEqual([]);
  });

  it('texto dos tributos aproximados (IBPT) na discriminação, como no eNotas', () => {
    const xml = buildEnviarLoteRps(
      invoice,
      {
        ...tenant,
        approximateTaxes: {
          rateBps: 1553,
          descriptionTemplate: 'Valor aprox dos tributos: R$ [ValorTributos]. Fonte: IBPT',
        },
      },
      NOW
    );
    // 35,00 × 15,53% = 5,44
    expect(xml).toContain(
      '<tipos:Discriminacao>Venda espaço Jely | Valor aprox dos tributos: R$ 5,44. Fonte: IBPT</tipos:Discriminacao>'
    );
  });

  it('tomador com CPF e e-mail; tomador vazio quando não há dados', async () => {
    const withCpf = buildEnviarLoteRps(makeInvoice({ taxProfile, dps: invoice.dps }), tenant, NOW);
    expect(withCpf).toContain(
      '<tipos:IdentificacaoTomador><tipos:CpfCnpj><tipos:Cpf>52998224725</tipos:Cpf>'
    );
    expect(withCpf).toContain('<tipos:Contato><tipos:Email>maria@example.com</tipos:Email>');
    const empty = buildEnviarLoteRps(
      makeInvoice({ taxProfile, dps: invoice.dps, customer: {} }),
      tenant,
      NOW
    );
    expect(empty).toContain('<tipos:Tomador></tipos:Tomador>');
    // Como no eNotas, o IBS/CBS vai mesmo sem endereço (incidência no município do prestador).
    expect(withCpf).toContain('<tipos:cLocalidadeIncid>3548708</tipos:cLocalidadeIncid>');
    expect(empty).toContain('<tipos:IBSCBS>');
    // Empresa (CNPJ) com endereço: não é consumidor final.
    const company = buildEnviarLoteRps(
      makeInvoice({
        taxProfile,
        dps: invoice.dps,
        customer: {
          name: 'Cliente LTDA',
          taxId: { kind: 'CNPJ', value: '11444777000161' },
          address: invoice.customer.address,
        },
      }),
      tenant,
      NOW
    );
    expect(company).toContain('<tipos:indFinal>0</tipos:indFinal>');
    expect(await rtcXsd(signLote(company, pfx))).toEqual([]);
    for (const xml of [withCpf, empty]) {
      expect(await rtcXsd(signLote(xml, pfx))).toEqual([]);
    }
    // Ordem do XSD do ACBr (grupos no fim de Valores) não é a da produção de SBC (E160).
    const acbr = await validateAgainstXsd(
      signLote(withCpf, pfx),
      'servico_enviar_lote_rps_envio_v03.xsd',
      'ginfes/rtc'
    );
    expect(acbr.join(' ')).toMatch(/trib|IBSCBS|ValorIss/);
  });

  it('consultas e cancelamento válidos nos XSDs', async () => {
    const cases: [string, string, string][] = [
      [
        buildConsultarSituacaoLote(tenant, '123'),
        'ConsultarSituacaoLoteRpsEnvio',
        'servico_consultar_situacao_lote_rps_envio_v03.xsd',
      ],
      [
        buildConsultarLote(tenant, '123'),
        'ConsultarLoteRpsEnvio',
        'servico_consultar_lote_rps_envio_v03.xsd',
      ],
      [
        buildConsultarNfseRps(invoice, tenant),
        'ConsultarNfseRpsEnvio',
        'servico_consultar_nfse_rps_envio_v03.xsd',
      ],
      [
        buildConsultarNfse(tenant, { from: NOW, to: NOW }),
        'ConsultarNfseEnvio',
        'servico_consultar_nfse_envio_v03.xsd',
      ],
    ];
    for (const [xml, root, schema] of cases) {
      const signed = signRoot(xml, root, pfx);
      expect(signed).toContain('URI=""');
      expect(verify(signed)).toBe(true);
      expect(await bothXsdSets(signed, schema)).toEqual({ sped: [], acbr: [] });
    }
    const byNumber = signRoot(
      buildConsultarNfse(tenant, { number: '48736' }),
      'ConsultarNfseEnvio',
      pfx
    );
    expect(byNumber).toContain('<NumeroNfse>48736</NumeroNfse>');
    expect(await bothXsdSets(byNumber, 'servico_consultar_nfse_envio_v03.xsd')).toEqual({
      sped: [],
      acbr: [],
    });
    const cancel = signCancelV3(buildCancelarV3(tenant, '4521', '2'), pfx);
    expect(cancel).toContain('<CodigoCancelamento>0002</CodigoCancelamento>');
    expect(cancel).toMatch(/<\/InfPedidoCancelamento><Signature/);
    expect(verify(cancel)).toBe(true);
    expect(
      await validateAgainstXsd(cancel, 'servico_cancelar_nfse_envio_v03.xsd', 'ginfes/sped')
    ).toEqual([]);
    const v2 = signRoot(buildCancelarV2(tenant, '4521'), 'CancelarNfseEnvio', pfx);
    expect(
      await validateAgainstXsd(v2, 'servico_cancelar_nfse_envio_v02.xsd', 'ginfes/sped')
    ).toEqual([]);
  });

  it('ValorIss: Simples retido ou fora do Simples leva o valor calculado', () => {
    const retido = buildEnviarLoteRps(
      { ...invoice, taxProfile: { ...taxProfile, issRetention: 'TOMADOR' } },
      tenant,
      NOW
    );
    expect(retido).toContain('<tipos:IssRetido>1</tipos:IssRetido>');
    expect(retido).toContain(
      '<tipos:ValorIss>0.70</tipos:ValorIss><tipos:ValorIssRetido>0.70</tipos:ValorIssRetido>'
    );
    const presumido = buildEnviarLoteRps(invoice, { ...tenant, taxRegime: 'LUCRO_PRESUMIDO' }, NOW);
    expect(presumido).toContain('<tipos:ValorIss>0.70</tipos:ValorIss>');
    expect(presumido).toContain('<tipos:OptanteSimplesNacional>2</tipos:OptanteSimplesNacional>');
  });

  it('regime especial: MEI 5, ME/EPP 6, demais pelo regime especial da empresa', () => {
    expect(regimeEspecialTributacao({ ...tenant, taxRegime: 'MEI' })).toBe('5');
    expect(regimeEspecialTributacao(tenant)).toBe('6');
    expect(regimeEspecialTributacao({ ...tenant, taxRegime: 'LUCRO_PRESUMIDO' })).toBeUndefined();
    expect(
      regimeEspecialTributacao({
        ...tenant,
        taxRegime: 'LUCRO_PRESUMIDO',
        specialTaxRegime: 'PROFESSIONAL_SOCIETY',
      })
    ).toBe('3');
  });

  it('conversões sem ponto flutuante', () => {
    expect(bpsToFraction(201)).toBe('0.0201');
    expect(bpsToFraction(500)).toBe('0.0500');
    expect(fractionToBps('0.0201')).toBe(201);
    expect(fractionToBps('0.05')).toBe(500);
    expect(decimalToCents('35')).toBe(3500);
    expect(decimalToCents('0.29')).toBe(29);
    expect(decimalToCents('1500.5')).toBe(150050);
    expect(ginfesDateTime(new Date('2026-10-19T13:00:00Z'))).toBe('2026-10-19T10:00:00');
    expect(itemListaServico(createTaxProfile({ nationalServiceCode: '170101' }))).toBe('17.01');
    expect(itemListaServico(taxProfile)).toBe('08.02');
  });

  it('SOAP: argumentos escapados no envelope; return desescapado; Fault vira indisponibilidade', () => {
    const env = soapEnvelope(
      'https://producao.ginfes.com.br/ServiceGinfesImpl',
      'RecepcionarLoteRpsV3',
      ['<a x="1">&</a>']
    );
    expect(env).toContain('<ns1:RecepcionarLoteRpsV3 xmlns:ns1="http://producao.ginfes.com.br">');
    expect(env).toContain('<arg0>&lt;a x=&quot;1&quot;&gt;&amp;&lt;/a&gt;</arg0>');
    expect(
      soapReturn(
        '<S:Envelope><S:Body><ns2:R><return>&lt;x&gt;é&amp;&lt;/x&gt;</return></ns2:R></S:Body></S:Envelope>'
      )
    ).toBe('<x>é&</x>');
    expect(() => soapReturn('<S:Fault><faultstring>boom</faultstring></S:Fault>')).toThrow(
      FiscalProviderUnavailableError
    );
  });

  it('resposta quebrada da prefeitura vira indisponibilidade (retentável)', () => {
    expect(() =>
      parseCompNfseList('<ns3:ConsultarNfseResposta><ns3:ListaNfse></ns3:Lista')
    ).toThrow(FiscalProviderUnavailableError);
  });

  it('lê a nota (CompNfse) com prefixos variados', () => {
    const [nfse] = parseCompNfseList(
      `<ns3:ConsultarNfseResposta xmlns:ns3="z"><ns3:ListaNfse>${compNfse()}</ns3:ListaNfse></ns3:ConsultarNfseResposta>`
    );
    expect(nfse).toMatchObject({
      number: '4521',
      verificationCode: 'AB12CD34E',
      amountCents: 3500,
      issRateBps: 201,
      customerDocument: '',
      rps: { number: '2', series: '900' },
      cancelled: false,
    });
    expect(nfse.issuedAt.toISOString()).toBe('2026-10-19T13:15:00.000Z');
  });
});

describe('GinfesFiscalProvider', () => {
  const config = {
    productionUrl: 'https://producao.ginfes.com.br/ServiceGinfesImpl',
    homologationUrl: 'https://homologacao.ginfes.com.br/ServiceGinfesImpl',
    pilot: true,
    pollDelaysMs: [0, 0, 0],
    verificationUrl: SBC_VERIFICATION_URL,
  };
  const prodTenant = { ...tenant, environment: 'PRODUCTION' as const };

  const scripted = (replies: Record<string, string[]>) => {
    const calls: { url: string; operation: string; args: string[] }[] = [];
    return {
      calls,
      transport: {
        async call(url: string, operation: string, args: string[]) {
          calls.push({ url, operation, args });
          const next = replies[operation]?.shift();
          if (next === undefined) throw new Error(`sem resposta para ${operation}`);
          return next;
        },
      },
    };
  };

  it('envia o lote, acompanha a situação e devolve a nota emitida', async () => {
    const s = scripted({
      RecepcionarLoteRpsV3: [
        '<ns3:EnviarLoteRpsResposta xmlns:ns3="x"><ns3:NumeroLote>2</ns3:NumeroLote><ns3:Protocolo>9988</ns3:Protocolo></ns3:EnviarLoteRpsResposta>',
      ],
      ConsultarSituacaoLoteRpsV3: [
        errorReply('ConsultarSituacaoLoteRpsResposta', 'E178', 'Lote aguardando processamento'),
        '<ns3:ConsultarSituacaoLoteRpsResposta xmlns:ns3="x"><ns3:Situacao>2</ns3:Situacao></ns3:ConsultarSituacaoLoteRpsResposta>',
        '<ns3:ConsultarSituacaoLoteRpsResposta xmlns:ns3="x"><ns3:Situacao>4</ns3:Situacao></ns3:ConsultarSituacaoLoteRpsResposta>',
      ],
      ConsultarLoteRpsV3: [
        `<ns3:ConsultarLoteRpsResposta xmlns:ns3="x"><ns3:ListaNfse>${compNfse()}</ns3:ListaNfse></ns3:ConsultarLoteRpsResposta>`,
      ],
    });
    const provider = new GinfesFiscalProvider(s.transport, config, { now: () => NOW });
    expect(provider.requiresApproval).toBe(true);
    const outcome = await provider.issue(invoice, prodTenant, material);
    expect(outcome).toMatchObject({
      kind: 'ISSUED',
      nfse: { provider: 'GINFES', number: '4521', accessKey: 'AB12CD34E', amountCents: 3500 },
    });
    if (outcome.kind === 'ISSUED') {
      expect(outcome.nfse.verificationUrl).toContain('cdVerificacao=AB12CD34E&numNota=4521');
    }
    expect(s.calls.map((c) => c.operation)).toEqual([
      'RecepcionarLoteRpsV3',
      'ConsultarSituacaoLoteRpsV3',
      'ConsultarSituacaoLoteRpsV3',
      'ConsultarSituacaoLoteRpsV3',
      'ConsultarLoteRpsV3',
    ]);
    expect(s.calls[0].url).toBe(config.productionUrl);
    expect(s.calls[0].args[0]).toContain('<versaoDados>3</versaoDados>');
  });

  it('erros do lote viram rejeição; RPS já informado vira duplicidade', async () => {
    const rejected = scripted({
      RecepcionarLoteRpsV3: ['<x/>'],
    });
    rejected.transport.call = async (url, operation) => {
      rejected.calls.push({ url, operation, args: [] });
      if (operation === 'RecepcionarLoteRpsV3') {
        return '<ns3:EnviarLoteRpsResposta xmlns:ns3="x"><ns3:Protocolo>1</ns3:Protocolo></ns3:EnviarLoteRpsResposta>';
      }
      if (operation === 'ConsultarSituacaoLoteRpsV3') {
        return '<r><Situacao>3</Situacao></r>';
      }
      return errorReply('ConsultarLoteRpsResposta', 'E35', 'Código de tributação inexistente');
    };
    const provider = new GinfesFiscalProvider(rejected.transport, config, { now: () => NOW });
    expect(await provider.issue(invoice, prodTenant, material)).toEqual({
      kind: 'REJECTED',
      errors: [{ code: 'E35', message: 'Código de tributação inexistente', complement: undefined }],
    });

    const dup = scripted({
      RecepcionarLoteRpsV3: [errorReply('EnviarLoteRpsResposta', 'E10', 'RPS já informado')],
    });
    expect(
      await new GinfesFiscalProvider(dup.transport, config).issue(invoice, prodTenant, material)
    ).toMatchObject({ kind: 'DUPLICATE' });
  });

  it('lote ainda em processamento: lança indisponibilidade para a fila consultar depois', async () => {
    const s = scripted({
      RecepcionarLoteRpsV3: ['<r><Protocolo>7</Protocolo></r>'],
      ConsultarSituacaoLoteRpsV3: [
        '<r><Situacao>2</Situacao></r>',
        '<r><Situacao>2</Situacao></r>',
        '<r><Situacao>1</Situacao></r>',
      ],
    });
    await expect(
      new GinfesFiscalProvider(s.transport, config).issue(invoice, prodTenant, material)
    ).rejects.toThrow(FiscalProviderUnavailableError);
  });

  it('pendências de cadastro rejeitam sem chamar a prefeitura', async () => {
    const s = scripted({});
    const outcome = await new GinfesFiscalProvider(s.transport, config).issue(
      makeInvoice({ dps: invoice.dps }),
      { ...prodTenant, municipalRegistration: undefined },
      material
    );
    expect(outcome.kind).toBe('REJECTED');
    if (outcome.kind === 'REJECTED') {
      expect(outcome.errors.map((e) => e.message).join(' ')).toMatch(/CCM.*localServiceCode/s);
    }
    expect(s.calls).toEqual([]);
  });

  it('consulta por RPS: encontra, não encontra (E4) ou falha', async () => {
    const s = scripted({
      ConsultarNfsePorRpsV3: [
        `<ns3:ConsultarNfseResposta xmlns:ns3="x">${compNfse()}</ns3:ConsultarNfseResposta>`,
        errorReply(
          'ConsultarNfseRpsResposta',
          'E4',
          'Esse RPS não foi encontrado em nossa base de dados'
        ),
        // Resposta real de São Bernardo (19/10/2026).
        errorReply(
          'ConsultarNfseRpsResposta',
          'E89',
          'Não existe na base de dados uma NFS-e emitida para o número de RPS informado'
        ),
        errorReply('ConsultarNfseRpsResposta', 'E1', 'Assinatura do Hash não confere'),
      ],
    });
    const provider = new GinfesFiscalProvider(s.transport, config);
    expect(await provider.findByDpsId(invoice, prodTenant, material)).toMatchObject({
      number: '4521',
    });
    expect(await provider.findByDpsId(invoice, prodTenant, material)).toBeNull();
    expect(await provider.findByDpsId(invoice, prodTenant, material)).toBeNull();
    await expect(provider.findByDpsId(invoice, prodTenant, material)).rejects.toThrow(/E1/);
  });

  it('cancela pelo v3 e cai para o v2 se a prefeitura não reconhecer a estrutura', async () => {
    const issued = {
      ...invoice,
      nfse: { accessKey: 'AB', number: '4521', issuedAt: NOW, xml: '', verificationUrl: '' },
    };
    const ok = scripted({
      CancelarNfseV3: [
        '<ns3:CancelarNfseResposta xmlns:ns3="x"><ns3:Cancelamento><Confirmacao><InfConfirmacaoCancelamento><Sucesso>true</Sucesso></InfConfirmacaoCancelamento></Confirmacao></ns3:Cancelamento></ns3:CancelarNfseResposta>',
      ],
    });
    expect(
      await new GinfesFiscalProvider(ok.transport, config).cancel(issued, prodTenant, material, {
        code: '2',
        description: 'x',
      })
    ).toEqual({ ok: true });

    const fallback = scripted({
      CancelarNfseV3: [
        errorReply('CancelarNfseResposta', 'E160', 'Arquivo em desacordo com o XML Schema'),
      ],
      CancelarNfse: ['<CancelarNfseResposta><Sucesso>true</Sucesso></CancelarNfseResposta>'],
    });
    expect(
      await new GinfesFiscalProvider(fallback.transport, config).cancel(
        issued,
        prodTenant,
        material,
        { code: '2', description: 'x' }
      )
    ).toEqual({ ok: true });
    expect(fallback.calls.map((c) => c.operation)).toEqual(['CancelarNfseV3', 'CancelarNfse']);
    expect(fallback.calls[1].args).toHaveLength(1); // v2 não tem cabeçalho

    // SBC (19/10/2026): v3 recusado com E344 (município); o v2 não leva município.
    const municipio = scripted({
      CancelarNfseV3: [
        errorReply(
          'CancelarNfseResposta',
          'E344',
          'Código do Município difere do informado na nota'
        ),
      ],
      CancelarNfse: ['<CancelarNfseResposta><Sucesso>true</Sucesso></CancelarNfseResposta>'],
    });
    expect(
      await new GinfesFiscalProvider(municipio.transport, config).cancel(
        issued,
        prodTenant,
        material,
        {
          code: '1',
          description: 'x',
        }
      )
    ).toEqual({ ok: true });
    expect(municipio.calls[1].args[0]).not.toContain('CodigoMunicipio');
  });

  it('traz uma nota pelo número com os campos gravados pela prefeitura', async () => {
    const withDetails = compNfse().replace(
      '<ns4:Servico>',
      '<ns4:NaturezaOperacao>1</ns4:NaturezaOperacao><ns4:RegimeEspecialTributacao>6</ns4:RegimeEspecialTributacao><ns4:OptanteSimplesNacional>1</ns4:OptanteSimplesNacional><ns4:Servico>'
    );
    const s = scripted({
      ConsultarNfseV3: [
        `<ns3:ConsultarNfseResposta xmlns:ns3="x"><ns3:ListaNfse>${withDetails}</ns3:ListaNfse></ns3:ConsultarNfseResposta>`,
        errorReply('ConsultarNfseResposta', 'E81', 'Não foi encontrada nenhuma NFS-e'),
      ],
    });
    const provider = new GinfesFiscalProvider(s.transport, config);
    const nfse = await provider.getIssued(prodTenant, material, '4521');
    expect(nfse).toMatchObject({
      number: '4521',
      details: { regimeEspecialTributacao: '6', optanteSimplesNacional: '1', aliquota: '0.0201' },
    });
    expect(nfse!.xml).toContain('CompNfse');
    expect(s.calls[0].args[1]).toContain('<NumeroNfse>4521</NumeroNfse>');
    expect(await provider.getIssued(prodTenant, material, '1')).toBeNull();
    // Com a data: consulta o dia (caminho da listagem) e filtra pelo número.
    const byDay = scripted({
      ConsultarNfseV3: [
        `<ns3:ConsultarNfseResposta xmlns:ns3="x"><ns3:ListaNfse>${compNfse({ number: '1' })}${compNfse({ number: '4521' })}</ns3:ListaNfse></ns3:ConsultarNfseResposta>`,
      ],
    });
    const viaDay = await new GinfesFiscalProvider(byDay.transport, config).getIssued(
      prodTenant,
      material,
      '4521',
      new Date('2026-10-19T15:00:00Z')
    );
    expect(viaDay).toMatchObject({ number: '4521', customerName: 'Bruno Lima' });
    expect(byDay.calls[0].args[1]).toContain(
      '<PeriodoEmissao><DataInicial>2026-10-19</DataInicial><DataFinal>2026-10-19</DataFinal>'
    );
    expect(byDay.calls[0].args[1]).not.toContain('NumeroNfse');
  });

  it('lista as notas do período (inclusive de outros sistemas)', async () => {
    const s = scripted({
      ConsultarNfseV3: [
        `<ns3:ConsultarNfseResposta xmlns:ns3="x"><ns3:ListaNfse>${compNfse({ number: '1', doc: '52998224725' })}${compNfse({ number: '2', amount: '97' })}</ns3:ListaNfse></ns3:ConsultarNfseResposta>`,
        errorReply(
          'ConsultarNfseResposta',
          'E81',
          'Não foi encontrada nenhuma NFS-e para os parâmetros informados'
        ),
      ],
    });
    const provider = new GinfesFiscalProvider(s.transport, config);
    const list = await provider.listIssued(prodTenant, material, { from: NOW, to: NOW });
    expect(list.map((n) => [n.number, n.amountCents, n.customerDocument])).toEqual([
      ['1', 3500, '52998224725'],
      ['2', 9700, ''],
    ]);
    expect(list[0]).not.toHaveProperty('xml');
    expect(await provider.listIssued(prodTenant, material, { from: NOW, to: NOW })).toEqual([]);
  });

  it('homologação usa o endpoint de homologação', async () => {
    const s = scripted({ ConsultarNfseV3: ['<r/>'] });
    await new GinfesFiscalProvider(s.transport, config).listIssued(
      { ...tenant, environment: 'HOMOLOGATION' },
      material,
      { from: NOW, to: NOW }
    );
    expect(s.calls[0].url).toBe(config.homologationUrl);
  });

  it('grupos da reforma ligados por configuração (padrão: nenhum, formato já autorizado em SBC)', () => {
    const none = new GinfesFiscalProvider(scripted({}).transport, config, { now: () => NOW });
    expect(none.preview(invoice, prodTenant)).not.toMatch(/CodigoNbs|<tipos:trib>|IBSCBS/);
    const nbsOnly = new GinfesFiscalProvider(
      scripted({}).transport,
      { ...config, rtcGroups: ['nbs'] },
      { now: () => NOW }
    );
    const xml = nbsOnly.preview(invoice, prodTenant);
    expect(xml).toContain('<tipos:CodigoNbs>122051900</tipos:CodigoNbs>');
    expect(xml).not.toMatch(/<tipos:trib>|IBSCBS/);
  });

  it('prévia mostra o lote sem assinatura, ou as pendências', () => {
    const provider = new GinfesFiscalProvider(scripted({}).transport, config, { now: () => NOW });
    expect(provider.preview(invoice, prodTenant)).toContain('<EnviarLoteRpsEnvio');
    expect(provider.preview(invoice, prodTenant)).not.toContain('Signature');
    expect(provider.preview(makeInvoice(), prodTenant)).toMatch(/Pendências.*localServiceCode/);
  });
});
