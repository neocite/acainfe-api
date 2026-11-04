import { DOMParser } from '@xmldom/xmldom';
import { gunzipSync, gzipSync } from 'node:zlib';
import { MunicipalNfseSummary } from '../../../../application/ports/fiscal-provider.js';
import { IssuedNfse } from '../../../../domain/invoice/invoice.js';

export const gzipBase64 = (xml: string): string =>
  gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
export const gunzipBase64 = (b64: string): string =>
  gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

export const publicVerificationUrl = (accessKey: string): string =>
  `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${accessKey}`;

function firstText(doc: Document, localName: string): string | undefined {
  const nodes = doc.getElementsByTagNameNS('*', localName);
  return nodes.length ? (nodes[0].textContent ?? undefined) : undefined;
}

/** Extrai número, chave e data de processamento do XML da NFS-e devolvido pela Sefin. */
export function parseNfseXml(xml: string, fallbackAccessKey?: string): IssuedNfse {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const inf = doc.getElementsByTagNameNS('*', 'infNFSe')[0];
  const accessKey = inf?.getAttribute('Id')?.replace(/^NFS/, '') || fallbackAccessKey;
  const number = firstText(doc, 'nNFSe');
  const dhProc = firstText(doc, 'dhProc');
  if (!accessKey || !number) throw new Error('XML da NFS-e sem chave de acesso ou número');
  // O DPS enviado vem ecoado dentro da NFS-e: dele lemos valor e tomador para conferir a nota.
  const infDps = doc.getElementsByTagNameNS('*', 'infDPS')[0];
  let amountCents: number | undefined;
  let customerDocument: string | undefined;
  if (infDps) {
    const vServ = infDps.getElementsByTagNameNS('*', 'vServ')[0]?.textContent;
    if (vServ) amountCents = Math.round(Number(vServ) * 100);
    const toma = infDps.getElementsByTagNameNS('*', 'toma')[0];
    customerDocument = '';
    if (toma) {
      for (const tag of ['CNPJ', 'CPF', 'NIF']) {
        const v = toma.getElementsByTagNameNS('*', tag)[0]?.textContent;
        if (v) {
          customerDocument = v;
          break;
        }
      }
    }
  }
  return {
    accessKey,
    number,
    issuedAt: dhProc ? new Date(dhProc) : new Date(),
    xml,
    verificationUrl: publicVerificationUrl(accessKey),
    amountCents,
    customerDocument,
  };
}

export interface NfseSummary {
  issuerName?: string;
  issuerAddress?: string;
  municipality?: string;
  serviceName?: string;
  issBase?: string;
  /** Texto da alíquota aplicada como veio no XML (ex.: "2.00"). */
  issRateText?: string;
  issValue?: string;
  netValue?: string;
  totalRetained?: string;
}

/** Campos calculados pela Sefin usados no DANFSe (valores, ISS apurado, descrição do código). */
export function summarizeNfseXml(xml: string): NfseSummary {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const emit = doc.getElementsByTagNameNS('*', 'emit')[0];
  const emitText = (name: string): string | undefined => {
    const n = emit?.getElementsByTagNameNS('*', name)[0];
    return n?.textContent ?? undefined;
  };
  return {
    issuerName: emitText('xNome'),
    issuerAddress:
      [emitText('xLgr'), emitText('nro'), emitText('xBairro')].filter(Boolean).join(', ') ||
      undefined,
    municipality: firstText(doc, 'xLocEmi'),
    serviceName: firstText(doc, 'xTribNac'),
    issBase: firstText(doc, 'vBC'),
    issRateText: firstText(doc, 'pAliqAplic'),
    issValue: firstText(doc, 'vISSQN'),
    netValue: firstText(doc, 'vLiq'),
    totalRetained: firstText(doc, 'vTotalRet'),
  };
}

/** O ADN devolve o XML em base64, comprimido (gzip) ou não. */
export function decodeDfeXml(b64: string): string {
  const raw = Buffer.from(b64, 'base64');
  return (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8');
}

/** Registro efetivo de cancelamento. Pedido em análise (101103) ou indeferido (105105) não conta. */
const CANCELLATION_EVENT_TYPES = new Set([
  'CANCELAMENTO',
  'CANCELAMENTO_POR_SUBSTITUICAO',
  'CANCELAMENTO_DEFERIDO_ANALISE_FISCAL',
  'CANCELAMENTO_POR_OFICIO',
]);
const CANCELLATION_EVENT_XML = /<(?:\w+:)?[eE](101101|105102|105104|305101)[\s>/]/;

export function isCancellationEvent(eventType: unknown, xml?: string): boolean {
  if (typeof eventType === 'string' && eventType) return CANCELLATION_EVENT_TYPES.has(eventType);
  return Boolean(xml && CANCELLATION_EVENT_XML.test(xml));
}

/** Nota do ADN no formato da consulta à prefeitura, com o CNPJ do prestador para filtrar. */
export function parseDistributedNfse(
  xml: string,
  fallbackAccessKey?: string
): MunicipalNfseSummary & { xml: string; accessKey: string; providerCnpj?: string } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  const nfse = parseNfseXml(xml, fallbackAccessKey);
  const inside = (parent: string, tag: string): string | undefined =>
    doc.getElementsByTagNameNS('*', parent)[0]?.getElementsByTagNameNS('*', tag)[0]?.textContent ??
    undefined;
  const rate = firstText(doc, 'pAliqAplic') ?? firstText(doc, 'pAliq');
  const dpsNumber = firstText(doc, 'nDPS');
  return {
    xml,
    accessKey: nfse.accessKey,
    providerCnpj: inside('prest', 'CNPJ') ?? inside('emit', 'CNPJ'),
    number: nfse.number,
    verificationCode: nfse.accessKey,
    issuedAt: nfse.issuedAt,
    rps: dpsNumber ? { number: dpsNumber, series: firstText(doc, 'serie') ?? '' } : undefined,
    amountCents: nfse.amountCents ?? 0,
    issRateBps: rate ? Math.round(Number(rate) * 100) : undefined,
    serviceItem: firstText(doc, 'cTribNac'),
    municipalTaxCode: firstText(doc, 'cTribMun'),
    customerDocument: nfse.customerDocument || undefined,
    customerName: inside('toma', 'xNome'),
    description: firstText(doc, 'xDescServ'),
    details: {
      ambienteGerador: firstText(doc, 'ambGer'),
      competencia: firstText(doc, 'dCompet'),
      municipio: firstText(doc, 'xLocEmi'),
      valorIss: firstText(doc, 'vISSQN'),
    },
  };
}
