import { createSign } from 'node:crypto';
import { Invoice } from '../../../../domain/invoice/invoice.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { centsToPlainDecimal } from '../../../../domain/shared/money.js';
import {
  approximateTaxRateBps,
  companyIssRateBps,
  Tenant,
} from '../../../../domain/tenant/tenant.js';
import { PfxContents } from '../../crypto/pfx.js';
import { ufFromIbge } from '../ginfes/ginfes-xml.js';
import { cleanText, el, formatDateBrt } from '../nacional/xml.js';
import { withApproximateTaxes } from '../shared/approximate-taxes.js';

/**
 * NFS-e Paulistana (Prefeitura de São Paulo), leiaute 1 — o exigido para optantes do Simples até a
 * migração para o Emissor Nacional (erro 641). Manual do Web Service v3.3.9 e XSDs v01 em
 * test/fixtures/xsd/paulistana. Raiz no namespace da prefeitura, filhos sem namespace (xmlns="").
 */
export const PAULISTANA_NS = 'http://www.prefeitura.sp.gov.br/nfe';

const digits = (value: string | undefined): string => (value ?? '').replace(/\D/g, '');

/** CCM do prestador (até 8 dígitos no leiaute 1). */
export const inscricaoPrestador = (tenant: Tenant): string => digits(tenant.municipalRegistration);

/** Código de serviço de SP (4 ou 5 dígitos, ex.: 05762). */
export const codigoServico = (invoice: Invoice): string =>
  digits(invoice.taxProfile.localServiceCode);

/** Pontos-base → fração sem zeros à direita (500 → "0.05", 201 → "0.0201", 290 → "0.029"). */
export function bpsToTrimmedFraction(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw DomainError.validation('Alíquota inválida para a NFS-e Paulistana', { bps });
  }
  if (bps === 0) return '0';
  return `0.${String(bps).padStart(4, '0').replace(/0+$/, '')}`;
}

/** Texto aceito pela prefeitura: só Latin-1 (sem emoji) e sem quebras de linha. */
const latin1 = (value: string, max: number): string =>
  cleanText(value.replace(/\s*\n\s*/g, ' | '), max * 2)
    .replace(/[^ -ÿ]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);

const issRateBps = (invoice: Invoice, tenant: Tenant): number | undefined =>
  invoice.taxProfile.issRateBps ?? companyIssRateBps(tenant);

/** Pendências que impedem montar o RPS (mensagens para o usuário). */
export function paulistanaMissingFields(invoice: Invoice, tenant: Tenant): string[] {
  const missing: string[] = [];
  const ccm = inscricaoPrestador(tenant);
  if (!ccm || ccm.length > 8) {
    missing.push(
      'Inscrição municipal (CCM) da empresa, com até 8 dígitos: obrigatória na NFS-e de São Paulo. Informe com update_company (municipalRegistration).'
    );
  }
  if (!/^\d{4,5}$/.test(codigoServico(invoice))) {
    missing.push(
      'Código de serviço da prefeitura de São Paulo no produto (localServiceCode com 5 dígitos, ex.: 05762 para cursos e treinamentos).'
    );
  }
  if (invoice.customer.foreign) {
    missing.push('Tomador no exterior ainda não é suportado na emissão pela NFS-e de São Paulo.');
  }
  if (invoice.customer.taxId?.kind === 'CNPJ' && !invoice.customer.address) {
    missing.push(
      'Endereço do tomador: obrigatório em São Paulo quando o cliente é empresa (CNPJ).'
    );
  }
  if (issRateBps(invoice, tenant) === undefined) {
    missing.push('Alíquota de ISS (issRateBps) não definida para o produto nem para a empresa.');
  }
  return missing;
}

/** Série e número do RPS: a série/número reservados para a nota (série própria do açaínfe). */
export const rpsKey = (invoice: Invoice) => ({
  series: invoice.dps.series.slice(0, 5),
  number: String(invoice.dps.number),
});

/**
 * String da assinatura do RPS (leiaute 1, 86 posições): CCM(8) série(5, espaços à direita)
 * número(12) data AAAAMMDD tributação(1) status(1) ISS retido S/N valor serviços(15, centavos)
 * deduções(15) código do serviço(5) indicador do tomador(1: 1 CPF, 2 CNPJ, 3 não informado)
 * CPF/CNPJ do tomador(14).
 */
export function rpsSignatureString(invoice: Invoice, tenant: Tenant): string {
  const { series, number } = rpsKey(invoice);
  const taxId = invoice.customer.taxId;
  const indicator = !taxId ? '3' : taxId.kind === 'CPF' ? '1' : '2';
  return [
    inscricaoPrestador(tenant).padStart(8, '0'),
    series.padEnd(5, ' '),
    number.padStart(12, '0'),
    formatDateBrt(invoice.competenceDate).replace(/-/g, ''),
    'T',
    'N',
    invoice.taxProfile.issRetention !== 'NONE' ? 'S' : 'N',
    String(invoice.amountCents).padStart(15, '0'),
    '0'.padStart(15, '0'),
    codigoServico(invoice).padStart(5, '0'),
    indicator,
    (taxId?.value ?? '').padStart(14, '0'),
  ].join('');
}

/** RSA-SHA1 (PKCS#1 v1.5) da string em ASCII, em base64 — sem aplicar SHA1 antes. */
export const signAscii = (value: string, pfx: PfxContents): string =>
  createSign('RSA-SHA1').update(value, 'ascii').sign(pfx.privateKeyPem, 'base64');

const cabecalho = (tenant: Tenant, extra: string[] = []) =>
  el('Cabecalho', [el('CPFCNPJRemetente', [el('CNPJ', tenant.cnpj)]), ...extra], {
    Versao: '1',
    xmlns: '',
  });

function tomador(invoice: Invoice): string[] {
  const customer = invoice.customer;
  const address = customer.address;
  return [
    customer.taxId
      ? el('CPFCNPJTomador', [
          el(customer.taxId.kind === 'CPF' ? 'CPF' : 'CNPJ', customer.taxId.value),
        ])
      : '',
    customer.name ? el('RazaoSocialTomador', latin1(customer.name, 75)) : '',
    address
      ? el('EnderecoTomador', [
          el('Logradouro', latin1(address.street, 50)),
          el('NumeroEndereco', latin1(address.number, 10)),
          address.complement ? el('ComplementoEndereco', latin1(address.complement, 30)) : '',
          el('Bairro', latin1(address.district, 30)),
          el('Cidade', address.cityCode),
          ufFromIbge(address.cityCode) ? el('UF', ufFromIbge(address.cityCode)!) : '',
          // CEP é inteiro no XSD: sem zero à esquerda (01310100 → 1310100), como no exemplo oficial.
          digits(address.zipCode) ? el('CEP', String(Number(digits(address.zipCode)))) : '',
        ])
      : '',
    customer.email ? el('EmailTomador', customer.email.slice(0, 75)) : '',
  ];
}

/** Carga tributária aproximada (Lei 12.741, IBPT) nos campos próprios do RPS. */
function cargaTributaria(invoice: Invoice, tenant: Tenant): string[] {
  const rate = approximateTaxRateBps(invoice.taxProfile, tenant);
  if (!rate) return [];
  return [
    el(
      'ValorCargaTributaria',
      centsToPlainDecimal(Math.round((invoice.amountCents * rate) / 10_000))
    ),
    el('PercentualCargaTributaria', bpsToTrimmedFraction(rate)),
    el('FonteCargaTributaria', (tenant.approximateTaxes?.source ?? 'IBPT').slice(0, 10)),
  ];
}

/** PedidoEnvioRPS com a assinatura do RPS (falta só a XMLDSig da mensagem). */
export function buildPedidoEnvioRps(invoice: Invoice, tenant: Tenant, pfx?: PfxContents): string {
  const { series, number } = rpsKey(invoice);
  const rps = el(
    'RPS',
    [
      el('Assinatura', pfx ? signAscii(rpsSignatureString(invoice, tenant), pfx) : 'PREVIA'),
      el('ChaveRPS', [
        el('InscricaoPrestador', inscricaoPrestador(tenant)),
        el('SerieRPS', series),
        el('NumeroRPS', number),
      ]),
      el('TipoRPS', 'RPS'),
      // Data do RPS = fato gerador: a competência da venda (ex.: vendas passadas).
      el('DataEmissao', formatDateBrt(invoice.competenceDate)),
      el('StatusRPS', 'N'),
      // T = tributado em São Paulo. A opção pelo Simples vem do cadastro do CCM, não do RPS.
      el('TributacaoRPS', 'T'),
      el('ValorServicos', centsToPlainDecimal(invoice.amountCents)),
      el('ValorDeducoes', '0'),
      el('CodigoServico', codigoServico(invoice)),
      // No Simples (DAS) a nota não destaca ISS; a alíquota é informativa (diferença gera só alerta).
      el('AliquotaServicos', bpsToTrimmedFraction(issRateBps(invoice, tenant)!)),
      el('ISSRetido', invoice.taxProfile.issRetention !== 'NONE' ? 'true' : 'false'),
      ...tomador(invoice),
      el('Discriminacao', latin1(withApproximateTaxes(invoice, tenant), 2000)),
      ...cargaTributaria(invoice, tenant),
    ],
    { xmlns: '' }
  );
  return `<PedidoEnvioRPS xmlns="${PAULISTANA_NS}">${cabecalho(tenant)}${rps}</PedidoEnvioRPS>`;
}

/** Consulta pela chave do RPS (idempotência) ou pelo número da NFS-e. */
export function buildPedidoConsultaNFe(
  tenant: Tenant,
  key: { rps: { series: string; number: string } } | { nfse: string }
): string {
  const ccm = el('InscricaoPrestador', inscricaoPrestador(tenant));
  const chave =
    'rps' in key
      ? el('ChaveRPS', [ccm, el('SerieRPS', key.rps.series), el('NumeroRPS', key.rps.number)])
      : el('ChaveNFe', [ccm, el('NumeroNFe', key.nfse)]);
  return `<PedidoConsultaNFe xmlns="${PAULISTANA_NS}">${cabecalho(tenant)}${el('Detalhe', [chave], { xmlns: '' })}</PedidoConsultaNFe>`;
}

/** Notas emitidas no período (no máximo 31 dias), 50 por página. */
export function buildPedidoConsultaEmitidas(
  tenant: Tenant,
  range: { from: Date; to: Date },
  page: number
): string {
  const header = el(
    'Cabecalho',
    [
      el('CPFCNPJRemetente', [el('CNPJ', tenant.cnpj)]),
      el('CPFCNPJ', [el('CNPJ', tenant.cnpj)]),
      el('Inscricao', inscricaoPrestador(tenant)),
      el('dtInicio', formatDateBrt(range.from)),
      el('dtFim', formatDateBrt(range.to)),
      el('NumeroPagina', String(page)),
    ],
    { Versao: '1', xmlns: '' }
  );
  return `<PedidoConsultaNFePeriodo xmlns="${PAULISTANA_NS}">${header}</PedidoConsultaNFePeriodo>`;
}

/** String da assinatura do cancelamento: CCM(8) + número da NFS-e(12). */
export const cancelSignatureString = (tenant: Tenant, nfseNumber: string): string =>
  `${inscricaoPrestador(tenant).padStart(8, '0')}${nfseNumber.padStart(12, '0')}`;

export function buildPedidoCancelamento(
  tenant: Tenant,
  nfseNumber: string,
  pfx: PfxContents
): string {
  const detalhe = el(
    'Detalhe',
    [
      el('ChaveNFe', [
        el('InscricaoPrestador', inscricaoPrestador(tenant)),
        el('NumeroNFe', nfseNumber),
      ]),
      el('AssinaturaCancelamento', signAscii(cancelSignatureString(tenant, nfseNumber), pfx)),
    ],
    { xmlns: '' }
  );
  return `<PedidoCancelamentoNFe xmlns="${PAULISTANA_NS}">${cabecalho(tenant, [el('transacao', 'true')])}${detalhe}</PedidoCancelamentoNFe>`;
}
