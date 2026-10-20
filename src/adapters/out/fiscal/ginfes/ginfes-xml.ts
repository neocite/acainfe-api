import { Invoice } from '../../../../domain/invoice/invoice.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { bpsToDecimal, centsToPlainDecimal } from '../../../../domain/shared/money.js';
import { companyIssRateBps, Tenant } from '../../../../domain/tenant/tenant.js';
import { cleanText, el, formatDateBrt } from '../nacional/xml.js';
import { withApproximateTaxes } from '../shared/approximate-taxes.js';

/**
 * Leiaute Ginfes v3 (ABRASF 1.0 com namespaces próprios), usado por São Bernardo do Campo.
 * XSDs em test/fixtures/xsd/ginfes (conjuntos sped-nfse-ginfes e ACBr).
 */
const NS = 'http://www.ginfes.com.br';
export const GINFES_NS = {
  tipos: `${NS}/tipos_v03.xsd`,
  cabecalho: `${NS}/cabecalho_v03.xsd`,
  enviarLote: `${NS}/servico_enviar_lote_rps_envio_v03.xsd`,
  situacaoLote: `${NS}/servico_consultar_situacao_lote_rps_envio_v03.xsd`,
  consultarLote: `${NS}/servico_consultar_lote_rps_envio_v03.xsd`,
  consultarNfseRps: `${NS}/servico_consultar_nfse_rps_envio_v03.xsd`,
  consultarNfse: `${NS}/servico_consultar_nfse_envio_v03.xsd`,
  cancelarV3: `${NS}/servico_cancelar_nfse_envio_v03.xsd`,
  cancelarV2: `${NS}/servico_cancelar_nfse_envio`,
  tiposV2: `${NS}/tipos`,
};

export const GINFES_CABECALHO = `<ns2:cabecalho versao="3" xmlns:ns2="${GINFES_NS.cabecalho}"><versaoDados>3</versaoDados></ns2:cabecalho>`;

/** Elemento do namespace tipos_v03 (elementFormDefault=qualified: todo filho leva o prefixo). */
const t = (name: string, content: Parameters<typeof el>[1], attrs?: Record<string, string>) =>
  el(`tipos:${name}`, content, attrs);

const BRT_OFFSET_MS = -3 * 3_600_000;
/** Ginfes espera data/hora local de Brasília sem fuso: AAAA-MM-DDThh:mm:ss. */
export const ginfesDateTime = (date: Date): string =>
  new Date(date.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 19);

/** Pontos-base → fração com 4 casas (2,01% = 201 → "0.0201"), sem ponto flutuante. */
export function bpsToFraction(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw DomainError.validation('Alíquota inválida para o Ginfes', { bps });
  }
  return `0.${String(bps).padStart(4, '0')}`;
}

const UF_BY_IBGE: Record<string, string> = {
  '11': 'RO',
  '12': 'AC',
  '13': 'AM',
  '14': 'RR',
  '15': 'PA',
  '16': 'AP',
  '17': 'TO',
  '21': 'MA',
  '22': 'PI',
  '23': 'CE',
  '24': 'RN',
  '25': 'PB',
  '26': 'PE',
  '27': 'AL',
  '28': 'SE',
  '29': 'BA',
  '31': 'MG',
  '32': 'ES',
  '33': 'RJ',
  '35': 'SP',
  '41': 'PR',
  '42': 'SC',
  '43': 'RS',
  '50': 'MS',
  '51': 'MT',
  '52': 'GO',
  '53': 'DF',
};
export const ufFromIbge = (cityCode: string): string | undefined =>
  UF_BY_IBGE[cityCode.slice(0, 2)];

/**
 * Item da LC 116 no formato do Ginfes ("08.02"): vem do código local da prefeitura
 * ("8.02/103911/1551") ou, sem ele, do código nacional ("080201").
 */
export function itemListaServico(profile: Invoice['taxProfile']): string {
  const local = profile.localServiceCode?.split('/')[0]?.trim();
  const match = local && /^(\d{1,2})\.(\d{2})$/.exec(local);
  if (match) return `${match[1].padStart(2, '0')}.${match[2]}`;
  const code = profile.nationalServiceCode;
  return `${code.slice(0, 2)}.${code.slice(2, 4)}`;
}

/**
 * RegimeEspecialTributacao (ABRASF + extensões do Ginfes): 1 ME municipal, 2 estimativa,
 * 3 sociedade de profissionais, 4 cooperativa, 5 MEI do Simples, 6 ME/EPP do Simples.
 * São Bernardo exige 5 ou 6 para optantes do Simples (rejeição E166).
 */
export function regimeEspecialTributacao(tenant: Tenant): string | undefined {
  if (tenant.taxRegime === 'MEI') return '5';
  if (tenant.taxRegime === 'SIMPLES_NACIONAL' || tenant.taxRegime === 'SIMPLES_NACIONAL_EXCESSO')
    return '6';
  const map: Partial<Record<NonNullable<Tenant['specialTaxRegime']>, string>> = {
    MICROENTERPRISE_MUNICIPAL: '1',
    ESTIMATE: '2',
    PROFESSIONAL_SOCIETY: '3',
    COOPERATIVE: '4',
  };
  return tenant.specialTaxRegime ? map[tenant.specialTaxRegime] : undefined;
}

const isSimples = (tenant: Tenant): boolean =>
  ['MEI', 'SIMPLES_NACIONAL', 'SIMPLES_NACIONAL_EXCESSO'].includes(tenant.taxRegime);

/** Pendências que impedem montar o RPS (mensagens para o usuário). */
export function ginfesMissingFields(invoice: Invoice, tenant: Tenant): string[] {
  const missing: string[] = [];
  if (!tenant.municipalRegistration) {
    missing.push(
      'Inscrição municipal (CCM) da empresa: obrigatória no Ginfes. Informe com update_company (municipalRegistration).'
    );
  }
  if (!invoice.taxProfile.localServiceCode) {
    missing.push(
      'Código de tributação municipal do produto (localServiceCode, ex.: 8.02/103911/1551): obrigatório em São Bernardo do Campo.'
    );
  }
  if (invoice.customer.foreign) {
    missing.push('Tomador no exterior ainda não é suportado na emissão pelo Ginfes.');
  }
  if (issRateBps(invoice, tenant) === undefined) {
    missing.push('Alíquota de ISS (issRateBps) não definida para o produto nem para a empresa.');
  }
  return missing;
}

const issRateBps = (invoice: Invoice, tenant: Tenant): number | undefined =>
  invoice.taxProfile.issRateBps ?? companyIssRateBps(tenant);

/** Identificação do RPS: reaproveita a série/número reservados para a nota (série própria do açaínfe). */
export const rpsIdentity = (invoice: Invoice) => ({
  number: String(invoice.dps.number),
  series: invoice.dps.series,
  type: '1',
});

const prestador = (tenant: Tenant) => [
  t('Cnpj', tenant.cnpj),
  t('InscricaoMunicipal', tenant.municipalRegistration ?? ''),
];

function tomador(invoice: Invoice): string {
  const customer = invoice.customer;
  const address = customer.address;
  const endereco =
    address &&
    t('Endereco', [
      t('Endereco', cleanText(address.street, 125)),
      t('Numero', cleanText(address.number, 10)),
      address.complement ? t('Complemento', cleanText(address.complement, 60)) : '',
      t('Bairro', cleanText(address.district, 60)),
      t('CodigoMunicipio', address.cityCode),
      ufFromIbge(address.cityCode) ? t('Uf', ufFromIbge(address.cityCode)!) : '',
      t('Cep', address.zipCode.replace(/\D/g, '')),
    ]);
  const identified = Boolean(customer.taxId);
  // Sem documento: só nome e endereço (se houver); sem nada, o grupo vai vazio.
  return t('Tomador', [
    identified
      ? t('IdentificacaoTomador', [
          t('CpfCnpj', [t(customer.taxId!.kind === 'CPF' ? 'Cpf' : 'Cnpj', customer.taxId!.value)]),
        ])
      : '',
    customer.name ? t('RazaoSocial', cleanText(customer.name, 115)) : '',
    endereco || '',
    customer.email ? t('Contato', [t('Email', customer.email.slice(0, 80))]) : '',
  ]);
}

/**
 * Reforma tributária no Ginfes de SBC, no formato de uma NFS-e autorizada emitida pelo eNotas
 * (nº 48714, 17/10/2026): grupos `trib` e `IBSCBS` logo depois de `IssRetido` (no fim de Valores,
 * como no XSD do ACBr, a prefeitura recusa com E160).
 *
 * totTrib: percentuais por esfera configurados na empresa; sem eles, zerados (como o eNotas faz —
 * o percentual do IBPT vai no texto da discriminação).
 */
function tribGroup(tenant: Tenant): string {
  const a = tenant.approximateTaxes;
  return t('trib', [
    t('totTrib', [
      t('pTotTrib', [
        t('pTotTribFed', a?.federalRateBps ? bpsToDecimal(a.federalRateBps) : '0'),
        t('pTotTribEst', a?.stateRateBps ? bpsToDecimal(a.stateRateBps) : '0'),
        t('pTotTribMun', a?.municipalRateBps ? bpsToDecimal(a.municipalRateBps) : '0'),
      ]),
    ]),
  ]);
}

/**
 * Grupo IBS/CBS como na nota autorizada: local de incidência = município do prestador (SBC), base
 * = valor do serviço. Vai mesmo sem endereço do tomador.
 */
function ibsCbsGroup(invoice: Invoice, tenant: Tenant): string {
  const ibs = invoice.taxProfile.ibsCbs;
  const customer = invoice.customer;
  if (!ibs || customer.foreign) return '';
  // Consumidor final: pessoa física (ou não identificada). Empresa (CNPJ) não é consumidor final.
  const finalConsumer = customer.taxId?.kind !== 'CNPJ';
  return t('IBSCBS', [
    t('finNFSe', '0'),
    t('indFinal', finalConsumer ? '1' : '0'),
    t('cIndOp', ibs.operationIndicator),
    t('indDest', '0'),
    t('valores', [
      t('trib', [t('gIBSCBS', [t('CST', ibs.cst), t('cClassTrib', ibs.cClassTrib)])]),
      t('cLocalidadeIncid', tenant.cityCode),
      t('pRedutor', '0'),
      t('vBC', centsToPlainDecimal(invoice.amountCents)),
    ]),
  ]);
}

/** Lote com um RPS (EnviarLoteRpsEnvio), ainda sem assinatura. */
/** Grupos da reforma tributária (layout 3.01) enviados no lote. */
export type GinfesRtcGroup = 'nbs' | 'trib' | 'ibscbs';
export const ALL_RTC_GROUPS: GinfesRtcGroup[] = ['nbs', 'trib', 'ibscbs'];

export function buildEnviarLoteRps(
  invoice: Invoice,
  tenant: Tenant,
  issuedAt: Date,
  rtc: readonly GinfesRtcGroup[] = ALL_RTC_GROUPS
): string {
  const rate = issRateBps(invoice, tenant)!;
  const amount = invoice.amountCents;
  const retained = invoice.taxProfile.issRetention !== 'NONE';
  const iss = Math.round((amount * rate) / 10_000);
  // Simples sem retenção: o ISS é pago no DAS, a nota leva ValorIss 0,00 (rejeição E208 em SBC).
  const issOnInvoice = isSimples(tenant) && !retained ? 0 : iss;
  const zero = '0.00';
  const rps = rpsIdentity(invoice);
  const infRps = t(
    'InfRps',
    [
      t('IdentificacaoRps', [t('Numero', rps.number), t('Serie', rps.series), t('Tipo', rps.type)]),
      t('DataEmissao', ginfesDateTime(issuedAt)),
      t('NaturezaOperacao', '1'),
      regimeEspecialTributacao(tenant)
        ? t('RegimeEspecialTributacao', regimeEspecialTributacao(tenant)!)
        : '',
      t('OptanteSimplesNacional', isSimples(tenant) ? '1' : '2'),
      t('IncentivadorCultural', tenant.culturalIncentive ? '1' : '2'),
      t('Status', '1'),
      t('Servico', [
        t('Valores', [
          t('ValorServicos', centsToPlainDecimal(amount)),
          // Sem ValorPis/ValorCofins: no layout 3.01 de SBC eles aparecem como retidos em dobro
          // (orientação da prefeitura, TOTVS DSERTSS1-41900, 29/09/2026).
          t('ValorInss', zero),
          t('ValorIr', zero),
          t('ValorCsll', zero),
          t('IssRetido', retained ? '1' : '2'),
          rtc.includes('trib') ? tribGroup(tenant) : '',
          rtc.includes('ibscbs') ? ibsCbsGroup(invoice, tenant) : '',
          t('ValorIss', centsToPlainDecimal(issOnInvoice)),
          // Como o ACBr: campos opcionais zerados não vão (em SBC, ValorIssRetido presente com
          // ISS não retido gera E197 "valor do ISS retido não coincide com o valor do ISS").
          retained ? t('ValorIssRetido', centsToPlainDecimal(iss)) : '',
          t('BaseCalculo', centsToPlainDecimal(amount)),
          t('Aliquota', bpsToFraction(rate)),
          t('ValorLiquidoNfse', centsToPlainDecimal(amount)),
        ]),
        t('ItemListaServico', itemListaServico(invoice.taxProfile)),
        t('CodigoTributacaoMunicipio', invoice.taxProfile.localServiceCode ?? ''),
        t(
          'Discriminacao',
          cleanText(withApproximateTaxes(invoice, tenant).replace(/\s*\n\s*/g, ' | '), 2000)
        ),
        t('CodigoMunicipio', tenant.cityCode),
        rtc.includes('nbs') && invoice.taxProfile.nbsCode
          ? t('CodigoNbs', invoice.taxProfile.nbsCode)
          : '',
      ]),
      t('Prestador', prestador(tenant)),
      tomador(invoice),
    ],
    { Id: `Rps_${rps.number}${rps.series}` }
  );
  // Número do lote derivado do horário (ms): não colide com lotes já enviados por outro sistema
  // (ex.: eNotas) nem entre reenvios do mesmo RPS. A idempotência fica no RPS (série/número).
  const numeroLote = String(issuedAt.getTime()).slice(-13);
  const lote = el(
    'LoteRps',
    [
      t('NumeroLote', numeroLote),
      ...prestador(tenant),
      t('QuantidadeRps', '1'),
      t('ListaRps', [t('Rps', [infRps])]),
    ],
    { Id: `Lote_${numeroLote}` }
  );
  return `<EnviarLoteRpsEnvio xmlns="${GINFES_NS.enviarLote}" xmlns:tipos="${GINFES_NS.tipos}">${lote}</EnviarLoteRpsEnvio>`;
}

const prestadorGroup = (tenant: Tenant) => el('Prestador', prestador(tenant));

export const buildConsultarSituacaoLote = (tenant: Tenant, protocolo: string): string =>
  `<ConsultarSituacaoLoteRpsEnvio xmlns="${GINFES_NS.situacaoLote}" xmlns:tipos="${GINFES_NS.tipos}">${prestadorGroup(tenant)}${el('Protocolo', protocolo)}</ConsultarSituacaoLoteRpsEnvio>`;

export const buildConsultarLote = (tenant: Tenant, protocolo: string): string =>
  `<ConsultarLoteRpsEnvio xmlns="${GINFES_NS.consultarLote}" xmlns:tipos="${GINFES_NS.tipos}">${prestadorGroup(tenant)}${el('Protocolo', protocolo)}</ConsultarLoteRpsEnvio>`;

export function buildConsultarNfseRps(invoice: Invoice, tenant: Tenant): string {
  const rps = rpsIdentity(invoice);
  const identificacao = el('IdentificacaoRps', [
    t('Numero', rps.number),
    t('Serie', rps.series),
    t('Tipo', rps.type),
  ]);
  return `<ConsultarNfseRpsEnvio xmlns="${GINFES_NS.consultarNfseRps}" xmlns:tipos="${GINFES_NS.tipos}">${identificacao}${prestadorGroup(tenant)}</ConsultarNfseRpsEnvio>`;
}

/** Consulta notas emitidas: por período e/ou por número da NFS-e. */
export function buildConsultarNfse(
  tenant: Tenant,
  filter: { from: Date; to: Date } | { number: string }
): string {
  const body =
    'number' in filter
      ? el('NumeroNfse', filter.number)
      : el('PeriodoEmissao', [
          el('DataInicial', formatDateBrt(filter.from)),
          el('DataFinal', formatDateBrt(filter.to)),
        ]);
  return `<ConsultarNfseEnvio xmlns="${GINFES_NS.consultarNfse}" xmlns:tipos="${GINFES_NS.tipos}">${prestadorGroup(tenant)}${body}</ConsultarNfseEnvio>`;
}

/**
 * Cancelamento v3 como o ACBr envia: Pedido sem namespace e InfPedidoCancelamento no tipos_v03.
 * Códigos ABRASF: 1 erro na emissão, 2 serviço não prestado, 4 duplicidade.
 */
export function buildCancelarV3(tenant: Tenant, nfseNumber: string, code: string): string {
  const inf = `<InfPedidoCancelamento xmlns="${GINFES_NS.tipos}">${el('IdentificacaoNfse', [
    el('Numero', nfseNumber),
    el('Cnpj', tenant.cnpj),
    el('InscricaoMunicipal', tenant.municipalRegistration ?? ''),
    el('CodigoMunicipio', tenant.cityCode),
  ])}${el('CodigoCancelamento', code.padStart(4, '0'))}</InfPedidoCancelamento>`;
  return `<CancelarNfseEnvio xmlns="${GINFES_NS.cancelarV3}"><Pedido xmlns="">${inf}</Pedido></CancelarNfseEnvio>`;
}

/** Cancelamento v2 (legado, sem código de cancelamento) — alternativa se a prefeitura recusar o v3. */
export const buildCancelarV2 = (tenant: Tenant, nfseNumber: string): string =>
  `<CancelarNfseEnvio xmlns="${GINFES_NS.cancelarV2}" xmlns:tipos="${GINFES_NS.tiposV2}"><Prestador><tipos:Cnpj>${tenant.cnpj}</tipos:Cnpj><tipos:InscricaoMunicipal>${tenant.municipalRegistration ?? ''}</tipos:InscricaoMunicipal></Prestador><NumeroNfse>${nfseNumber}</NumeroNfse></CancelarNfseEnvio>`;
