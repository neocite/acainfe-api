import { DOMParser } from '@xmldom/xmldom';
import {
  FiscalProviderUnavailableError,
  MunicipalNfseSummary,
} from '../../../../application/ports/fiscal-provider.js';
import { FiscalError, IssuedNfse } from '../../../../domain/invoice/invoice.js';
import { bpsToDecimal } from '../../../../domain/shared/money.js';
import { decimalToCents, fractionToBps } from '../ginfes/ginfes-parser.js';

type Node = Element;

function parse(xml: string): Document {
  try {
    return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  } catch (error) {
    throw new FiscalProviderUnavailableError(
      `A prefeitura de São Paulo devolveu uma resposta incompleta ou inválida; tente de novo mais tarde (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
      error
    );
  }
}

const all = (root: Document | Node, name: string): Node[] =>
  Array.from(root.getElementsByTagNameNS('*', name)) as Node[];
const first = (root: Document | Node | undefined, name: string): Node | undefined =>
  root ? all(root, name)[0] : undefined;
const text = (root: Document | Node | undefined, name: string): string | undefined =>
  first(root, name)?.textContent?.trim() || undefined;

/** Erros (impedem) e alertas (não impedem) do retorno. */
export function parseEvents(xml: string): { errors: FiscalError[]; alerts: FiscalError[] } {
  const doc = parse(xml);
  const map = (n: Node): FiscalError => ({
    code: text(n, 'Codigo') ?? 'PAULISTANA',
    message: text(n, 'Descricao') ?? 'Erro sem descrição',
  });
  return { errors: all(doc, 'Erro').map(map), alerts: all(doc, 'Alerta').map(map) };
}

export const isSuccess = (xml: string): boolean => text(parse(xml), 'Sucesso') === 'true';

/** Retorno do EnvioRPS: chave da NFS-e gerada (número e código de verificação) ou erros. */
export function parseEnvioRps(
  xml: string
): { number: string; verificationCode: string; alerts: FiscalError[] } | { errors: FiscalError[] } {
  const { errors, alerts } = parseEvents(xml);
  const chave = first(first(parse(xml), 'ChaveNFeRPS'), 'ChaveNFe');
  const number = text(chave, 'NumeroNFe');
  if (isSuccess(xml) && number) {
    return { number, verificationCode: text(chave, 'CodigoVerificacao') ?? '', alerts };
  }
  return {
    errors: errors.length
      ? errors
      : [{ code: 'PAULISTANA', message: `Resposta inesperada: ${xml.slice(0, 300)}` }],
  };
}

export interface ParsedNFe extends MunicipalNfseSummary {
  verificationCode: string;
  xml: string;
}

/** Data/hora local da prefeitura sem fuso → Brasília (-03:00). */
const withBrtOffset = (value: string | undefined): Date =>
  new Date(!value ? Date.now() : /([+-]\d{2}:\d{2}|Z)$/.test(value) ? value : `${value}-03:00`);

function parseNFe(nfe: Node): ParsedNFe {
  const chave = first(nfe, 'ChaveNFe');
  const rps = first(nfe, 'ChaveRPS');
  const tomador = first(nfe, 'CPFCNPJTomador');
  return {
    number: text(chave, 'NumeroNFe') ?? '',
    verificationCode: text(chave, 'CodigoVerificacao') ?? '',
    issuedAt: withBrtOffset(text(nfe, 'DataEmissaoNFe')),
    rps: rps
      ? { number: text(rps, 'NumeroRPS') ?? '', series: text(rps, 'SerieRPS') ?? '' }
      : undefined,
    amountCents: decimalToCents(text(nfe, 'ValorServicos')) ?? 0,
    issRateBps: fractionToBps(text(nfe, 'AliquotaServicos')),
    municipalTaxCode: text(nfe, 'CodigoServico'),
    customerDocument: text(tomador, 'CPF') ?? text(tomador, 'CNPJ') ?? '',
    customerName: text(nfe, 'RazaoSocialTomador'),
    description: text(nfe, 'Discriminacao'),
    cancelled: text(nfe, 'StatusNFe') === 'C',
    details: {
      tributacao: text(nfe, 'TributacaoNFe'),
      opcaoSimples: text(nfe, 'OpcaoSimples'),
      dataFatoGerador: text(nfe, 'DataFatoGeradorNFe'),
      aliquota: text(nfe, 'AliquotaServicos'),
      valorIss: text(nfe, 'ValorISS'),
      valorCredito: text(nfe, 'ValorCredito'),
      issRetido: text(nfe, 'ISSRetido'),
      codigoServico: text(nfe, 'CodigoServico'),
      statusNFe: text(nfe, 'StatusNFe'),
    },
    xml: (nfe as unknown as { toString(): string }).toString(),
  };
}

/** Notas (NFe) do RetornoConsulta (ConsultaNFe, ConsultaNFeEmitidas). */
export const parseNFeList = (xml: string): ParsedNFe[] => all(parse(xml), 'NFe').map(parseNFe);

export function toIssuedNfse(
  nfe: {
    number: string;
    verificationCode: string;
    xml: string;
    amountCents?: number;
    customerDocument?: string;
    issuedAt?: Date;
  },
  verificationUrl: string
): IssuedNfse {
  return {
    provider: 'PAULISTANA',
    accessKey: nfe.verificationCode,
    number: nfe.number,
    issuedAt: nfe.issuedAt ?? new Date(),
    xml: nfe.xml,
    verificationUrl,
    amountCents: nfe.amountCents,
    customerDocument: nfe.customerDocument,
  };
}

/** Campos para o PDF a partir da NFe da prefeitura (mesmo formato do resumo nacional). */
export function summarizePaulistanaXml(xml: string) {
  const doc = parse(xml);
  const endereco = first(doc, 'EnderecoPrestador');
  const rate = fractionToBps(text(doc, 'AliquotaServicos'));
  return {
    issuerName: text(doc, 'RazaoSocialPrestador'),
    issuerAddress:
      [text(endereco, 'Logradouro'), text(endereco, 'NumeroEndereco'), text(endereco, 'Bairro')]
        .filter(Boolean)
        .join(', ') || undefined,
    municipality: 'São Paulo/SP' as string | undefined,
    serviceName: text(doc, 'CodigoServico'),
    issBase: text(doc, 'ValorServicos'),
    issRateText: rate === undefined ? undefined : bpsToDecimal(rate),
    issValue: text(doc, 'ValorISS'),
    netValue: text(doc, 'ValorServicos'),
    totalRetained: undefined as string | undefined,
  };
}
