import { DOMParser } from '@xmldom/xmldom';
import { gunzipSync, gzipSync } from 'node:zlib';
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
