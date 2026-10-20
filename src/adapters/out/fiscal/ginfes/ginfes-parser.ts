import { DOMParser } from '@xmldom/xmldom';
import {
  FiscalProviderUnavailableError,
  MunicipalNfseSummary,
} from '../../../../application/ports/fiscal-provider.js';
import { FiscalError, IssuedNfse } from '../../../../domain/invoice/invoice.js';
import { bpsToDecimal } from '../../../../domain/shared/money.js';

type Node = Element;

/**
 * Resposta que não é XML válido (ex.: corte no meio por instabilidade do Ginfes) vira
 * indisponibilidade: a fila tenta de novo e as consultas avisam que é do lado da prefeitura.
 */
function parse(xml: string): Document {
  try {
    return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  } catch (error) {
    throw new FiscalProviderUnavailableError(
      `A prefeitura (Ginfes) devolveu uma resposta incompleta ou inválida; tente de novo mais tarde (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
      error
    );
  }
}

/** Busca por nome local, ignorando prefixos e namespaces (o Ginfes varia ns2/ns3/ns4). */
const all = (root: Document | Node, name: string): Node[] =>
  Array.from(root.getElementsByTagNameNS('*', name)) as Node[];
const first = (root: Document | Node, name: string): Node | undefined => all(root, name)[0];
const text = (root: Document | Node | undefined, name: string): string | undefined =>
  root ? first(root, name)?.textContent?.trim() || undefined : undefined;

/** Valor decimal do Ginfes ("35.00", "35") → centavos inteiros, por texto (sem float). */
export function decimalToCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(value.trim());
  if (!m) return undefined;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** Fração ("0.0201") → pontos-base (201). */
export function fractionToBps(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^0?\.(\d{1,4})\d*$/.exec(value.trim()) ?? /^(\d+)$/.exec(value.trim());
  if (!m) return undefined;
  return value.includes('.') ? Number(m[1].padEnd(4, '0')) : Number(m[1]) * 10_000;
}

export function parseMessages(xml: string): FiscalError[] {
  return all(parse(xml), 'MensagemRetorno').map((m) => ({
    code: text(m, 'Codigo') ?? 'GINFES',
    message: text(m, 'Mensagem') ?? 'Erro sem mensagem',
    complement: text(m, 'Correcao'),
  }));
}

export function parseEnviarLoteResposta(
  xml: string
): { protocolo: string } | { errors: FiscalError[] } {
  const protocolo = text(parse(xml), 'Protocolo');
  return protocolo ? { protocolo } : { errors: errorsOrUnknown(xml) };
}

/** Situação do lote: 1 não recebido, 2 não processado, 3 processado com erro, 4 sucesso. */
export function parseSituacaoLote(xml: string): { situacao: number } | { errors: FiscalError[] } {
  const situacao = text(parse(xml), 'Situacao');
  return situacao ? { situacao: Number(situacao) } : { errors: errorsOrUnknown(xml) };
}

function errorsOrUnknown(xml: string): FiscalError[] {
  const errors = parseMessages(xml);
  return errors.length
    ? errors
    : [{ code: 'GINFES', message: `Resposta inesperada: ${xml.slice(0, 300)}` }];
}

export interface ParsedCompNfse extends MunicipalNfseSummary {
  verificationCode: string;
  xml: string;
}

function parseCompNfse(comp: Node, xml: string): ParsedCompNfse {
  const inf = first(comp, 'InfNfse') ?? comp;
  const valores = first(inf, 'Valores');
  const tomador = first(inf, 'TomadorServico') ?? first(inf, 'Tomador');
  const rps = first(inf, 'IdentificacaoRps');
  const cancelled = Boolean(first(comp, 'NfseCancelamento'));
  return {
    number: text(inf, 'Numero') ?? '',
    verificationCode: text(inf, 'CodigoVerificacao') ?? '',
    issuedAt: new Date(withBrtOffset(text(inf, 'DataEmissao'))),
    rps: rps ? { number: text(rps, 'Numero') ?? '', series: text(rps, 'Serie') ?? '' } : undefined,
    amountCents: decimalToCents(text(valores, 'ValorServicos')) ?? 0,
    issRateBps: fractionToBps(text(valores, 'Aliquota')),
    serviceItem: text(inf, 'ItemListaServico'),
    municipalTaxCode: text(inf, 'CodigoTributacaoMunicipio'),
    customerDocument: tomador
      ? (text(first(tomador, 'CpfCnpj') ?? tomador, 'Cpf') ??
        text(first(tomador, 'CpfCnpj') ?? tomador, 'Cnpj') ??
        '')
      : '',
    customerName: text(tomador, 'RazaoSocial'),
    description: text(inf, 'Discriminacao'),
    cancelled,
    details: {
      naturezaOperacao: text(inf, 'NaturezaOperacao'),
      regimeEspecialTributacao: text(inf, 'RegimeEspecialTributacao'),
      optanteSimplesNacional: text(inf, 'OptanteSimplesNacional'),
      incentivadorCultural: text(inf, 'IncentivadorCultural'),
      competencia: text(inf, 'Competencia'),
      issRetido: text(valores, 'IssRetido'),
      valorIss: text(valores, 'ValorIss'),
      valorIssRetido: text(valores, 'ValorIssRetido'),
      baseCalculo: text(valores, 'BaseCalculo'),
      aliquota: text(valores, 'Aliquota'),
      valorLiquidoNfse: text(valores, 'ValorLiquidoNfse'),
      codigoCnae: text(inf, 'CodigoCnae'),
      codigoMunicipio: text(first(inf, 'Servico') ?? inf, 'CodigoMunicipio'),
    },
    xml,
  };
}

/** Data/hora local do Ginfes sem fuso → considera Brasília (-03:00). */
function withBrtOffset(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  return /([+-]\d{2}:\d{2}|Z)$/.test(value) ? value : `${value}-03:00`;
}

/** Notas (CompNfse) de ConsultarLote / ConsultarNfsePorRps / ConsultarNfse. */
export function parseCompNfseList(xml: string): ParsedCompNfse[] {
  const doc = parse(xml);
  return all(doc, 'CompNfse').map((comp) => parseCompNfse(comp, serialize(comp) ?? xml));
}

const serialize = (node: Node): string | undefined =>
  (node as unknown as { toString(): string }).toString();

export function toIssuedNfse(nfse: ParsedCompNfse, verificationUrl: string): IssuedNfse {
  return {
    provider: 'GINFES',
    accessKey: nfse.verificationCode,
    number: nfse.number,
    issuedAt: nfse.issuedAt,
    xml: nfse.xml,
    verificationUrl,
    amountCents: nfse.amountCents,
    customerDocument: nfse.customerDocument,
  };
}

/** Cancelamento: sucesso (Confirmacao/Sucesso=true) ou erros. */
export function parseCancelarResposta(
  xml: string
): { ok: true } | { ok: false; errors: FiscalError[] } {
  const doc = parse(xml);
  const sucesso = text(doc, 'Sucesso');
  if (sucesso === 'true' || (first(doc, 'Cancelamento') && !parseMessages(xml).length)) {
    return { ok: true };
  }
  return { ok: false, errors: errorsOrUnknown(xml) };
}

/** Campos para o PDF a partir do CompNfse do Ginfes (mesmo formato do resumo nacional). */
export function summarizeGinfesXml(xml: string) {
  const doc = parse(xml);
  const valores = first(doc, 'Valores');
  const prestador = first(doc, 'PrestadorServico');
  const endereco = prestador && first(prestador, 'Endereco');
  const rate = fractionToBps(text(valores, 'Aliquota'));
  return {
    issuerName: text(prestador, 'RazaoSocial'),
    issuerAddress:
      [text(endereco, 'Endereco'), text(endereco, 'Numero'), text(endereco, 'Bairro')]
        .filter(Boolean)
        .join(', ') || undefined,
    municipality: undefined as string | undefined,
    serviceName: text(doc, 'CodigoTributacaoMunicipio'),
    issBase: text(valores, 'BaseCalculo'),
    issRateText: rate === undefined ? undefined : bpsToDecimal(rate),
    issValue: text(valores, 'ValorIss'),
    netValue: text(valores, 'ValorLiquidoNfse'),
    totalRetained: undefined as string | undefined,
  };
}
