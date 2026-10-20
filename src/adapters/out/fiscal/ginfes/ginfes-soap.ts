import http from 'node:http';
import https from 'node:https';
import {
  CertificateMaterial,
  FiscalProviderUnavailableError,
} from '../../../../application/ports/fiscal-provider.js';
import { escapeXml } from '../nacional/xml.js';

export interface GinfesTransport {
  /**
   * Chama uma operação SOAP do Ginfes. `args` viram `<arg0>`, `<arg1>`… (XML escapado, como no
   * WSDL: xsd:string). Devolve o XML de dentro do `<return>`, já desescapado.
   */
  call(
    url: string,
    operation: string,
    args: string[],
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

/** Namespace da operação: http://producao.ginfes.com.br ou http://homologacao.ginfes.com.br. */
export const operationNamespace = (url: string): string =>
  /homologacao/.test(url) ? 'http://homologacao.ginfes.com.br' : 'http://producao.ginfes.com.br';

export function soapEnvelope(url: string, operation: string, args: string[]): string {
  const body = args.map((a, i) => `<arg${i}>${escapeXml(a)}</arg${i}>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><ns1:${operation} xmlns:ns1="${operationNamespace(url)}">${body}</ns1:${operation}></soapenv:Body></soapenv:Envelope>`;
}

/** Extrai o conteúdo de `<return>`; SOAP Fault vira erro de indisponibilidade (retentável). */
export function soapReturn(raw: string): string {
  const fault = /<(?:\w+:)?Fault\b[\s\S]*?<faultstring[^>]*>([\s\S]*?)<\/faultstring>/.exec(raw);
  if (fault)
    throw new FiscalProviderUnavailableError(`Ginfes SOAP Fault: ${unescapeXml(fault[1])}`);
  const ret = /<(?:\w+:)?return[^>]*>([\s\S]*?)<\/(?:\w+:)?return>/.exec(raw);
  if (!ret) throw new FiscalProviderUnavailableError('Resposta do Ginfes sem <return>');
  const content = ret[1].trim();
  return content.startsWith('<![CDATA[') ? content.slice(9, -3) : unescapeXml(content);
}

/**
 * SOAP 1.1 com TLS mútuo (A1 do prestador). O servidor do Ginfes só aceita TLS 1.2.
 * URLs http:// são aceitas apenas nos testes (Ginfes falso).
 */
export class HttpsGinfesTransport implements GinfesTransport {
  constructor(private readonly timeoutMs = 60_000) {}

  call(url: string, operation: string, args: string[], certificate: CertificateMaterial) {
    const target = new URL(url);
    const payload = soapEnvelope(url, operation, args);
    const isHttps = target.protocol === 'https:';
    const options: https.RequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: this.timeoutMs,
      ...(isHttps
        ? {
            pfx: certificate.pfx,
            passphrase: certificate.password,
            minVersion: 'TLSv1.2' as const,
            maxVersion: 'TLSv1.2' as const,
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
            if (status >= 500 && !/Fault/.test(raw)) {
              throw new FiscalProviderUnavailableError(`Ginfes HTTP ${status}`);
            }
            if (status >= 400 && status < 500) {
              throw new FiscalProviderUnavailableError(
                `Ginfes HTTP ${status}: ${raw.slice(0, 200)}`
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
        req.destroy(new FiscalProviderUnavailableError(`Ginfes timeout após ${this.timeoutMs}ms`))
      );
      req.on('error', (e) =>
        reject(
          e instanceof FiscalProviderUnavailableError
            ? e
            : new FiscalProviderUnavailableError(`Falha de conexão com o Ginfes: ${e.message}`, e)
        )
      );
      req.end(payload);
    });
  }
}
