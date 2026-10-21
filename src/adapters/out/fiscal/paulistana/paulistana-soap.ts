import http from 'node:http';
import https from 'node:https';
import {
  CertificateMaterial,
  FiscalProviderUnavailableError,
} from '../../../../application/ports/fiscal-provider.js';
import { tlsClientCredentials } from '../../crypto/pfx.js';
import { escapeXml } from '../nacional/xml.js';

/** Métodos do lotenfe.asmx usados pelo açaínfe. */
export type PaulistanaOperation =
  'EnvioRPS' | 'TesteEnvioLoteRPS' | 'ConsultaNFe' | 'ConsultaNFeEmitidas' | 'CancelamentoNFe';

const SOAP_ACTIONS: Record<PaulistanaOperation, string> = {
  EnvioRPS: 'envioRPS',
  TesteEnvioLoteRPS: 'testeenvio',
  ConsultaNFe: 'consultaNFe',
  ConsultaNFeEmitidas: 'consultaNFeEmitidas',
  CancelamentoNFe: 'cancelamentoNFe',
};

export interface PaulistanaTransport {
  /** Chama um método com a mensagem XML assinada e devolve o XML de retorno (RetornoXML). */
  call(
    url: string,
    operation: PaulistanaOperation,
    message: string,
    certificate: CertificateMaterial
  ): Promise<string>;
}

const unescapeXml = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/** SOAP 1.1 como os exemplos oficiais: VersaoSchema 1 e a mensagem como texto escapado. */
export const soapEnvelope = (operation: PaulistanaOperation, message: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><${operation}Request xmlns="http://www.prefeitura.sp.gov.br/nfe"><VersaoSchema>1</VersaoSchema><MensagemXML>${escapeXml(message)}</MensagemXML></${operation}Request></soap:Body></soap:Envelope>`;

export const soapAction = (operation: PaulistanaOperation): string =>
  `http://www.prefeitura.sp.gov.br/nfe/ws/${SOAP_ACTIONS[operation]}`;

/** Extrai o RetornoXML; SOAP Fault vira indisponibilidade (retentável). */
export function soapReturn(raw: string): string {
  const fault = /<(?:\w+:)?Fault\b[\s\S]*?<faultstring[^>]*>([\s\S]*?)<\/faultstring>/.exec(raw);
  if (fault) {
    throw new FiscalProviderUnavailableError(
      `NFS-e São Paulo SOAP Fault: ${unescapeXml(fault[1])}`
    );
  }
  const ret = /<(?:\w+:)?RetornoXML[^>]*>([\s\S]*?)<\/(?:\w+:)?RetornoXML>/.exec(raw);
  if (!ret) throw new FiscalProviderUnavailableError('Resposta da prefeitura de SP sem RetornoXML');
  const content = ret[1].trim();
  return content.startsWith('<![CDATA[') ? content.slice(9, -3) : unescapeXml(content);
}

/**
 * SOAP 1.1 com TLS mútuo (A1 do prestador; o CNPJ do certificado tem de ser o remetente) e
 * TLS 1.2 ou superior. URLs http:// são aceitas apenas nos testes (prefeitura falsa).
 */
export class HttpsPaulistanaTransport implements PaulistanaTransport {
  constructor(private readonly timeoutMs = 60_000) {}

  call(
    url: string,
    operation: PaulistanaOperation,
    message: string,
    certificate: CertificateMaterial
  ) {
    const target = new URL(url);
    const payload = soapEnvelope(operation, message);
    const isHttps = target.protocol === 'https:';
    const options: https.RequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${soapAction(operation)}"`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: this.timeoutMs,
      ...(isHttps
        ? {
            ...tlsClientCredentials(certificate),
            minVersion: 'TLSv1.2' as const,
          }
        : {}),
    };
    return new Promise<string>((resolve, reject) => {
      const req = (isHttps ? https : http).request(target, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          try {
            if (status >= 400 && !/Fault/.test(raw)) {
              throw new FiscalProviderUnavailableError(
                `NFS-e São Paulo HTTP ${status}: ${raw.slice(0, 200)}`
              );
            }
            resolve(soapReturn(raw));
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', (e) => reject(new FiscalProviderUnavailableError(e.message, e)));
      });
      req.on('timeout', () =>
        req.destroy(
          new FiscalProviderUnavailableError(`NFS-e São Paulo: timeout após ${this.timeoutMs}ms`)
        )
      );
      req.on('error', (e) =>
        reject(
          e instanceof FiscalProviderUnavailableError
            ? e
            : new FiscalProviderUnavailableError(
                `Falha de conexão com a NFS-e de São Paulo: ${e.message}`,
                e
              )
        )
      );
      req.end(payload);
    });
  }
}
