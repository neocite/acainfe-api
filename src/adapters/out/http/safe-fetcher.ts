import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { RemoteFileFetcher } from '../../../application/ports/services.js';
import { DomainError } from '../../../domain/shared/domain-error.js';

/** Bloqueia endereços internos (proteção contra SSRF ao baixar imagens informadas pelo usuário/IA). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return (
      v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
    );
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** GET sem descompactação, conectando no endereço já verificado. */
export type RawHttpGet = (
  url: URL,
  options: { maxBytes: number; timeoutMs: number; address: string }
) => Promise<RawResponse>;

export class ResponseTooLargeError extends Error {}
export class CompressedResponseError extends Error {}

/**
 * GET por node:http/https, que NÃO descompacta (ao contrário do fetch nativo, que pede e decodifica
 * Brotli/gzip sozinho — CVE-2026-111497, "Node2Shell", RCE no decodificador Brotli). Pede resposta
 * sem compressão e recusa qualquer Content-Encoding. Conecta no IP já verificado (sem nova consulta
 * DNS: evita DNS rebinding), com limite de tamanho e de tempo. Redirecionamento não é seguido.
 */
export const rawHttpGet: RawHttpGet = (url, { maxBytes, timeoutMs, address }) =>
  new Promise((resolve, reject) => {
    const family = isIP(address) || 4;
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'GET',
        headers: { 'accept-encoding': 'identity', 'user-agent': 'acainfe' },
        timeout: timeoutMs,
        lookup: ((
          _host: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void
        ) =>
          options?.all
            ? callback(null, [{ address, family }])
            : callback(null, address, family)) as never,
      },
      (res) => {
        const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (encoding !== 'identity') {
          res.destroy();
          reject(new CompressedResponseError(`resposta compactada (${encoding}) recusada`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new ResponseTooLargeError('resposta maior que o limite'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`tempo esgotado (${timeoutMs}ms)`)));
    req.on('error', reject);
    req.end();
  });

type Resolver = (host: string) => Promise<string[]>;
const dnsResolve: Resolver = async (h) => (await lookup(h, { all: true })).map((r) => r.address);

/**
 * Baixa um endereço informado por terceiros (usuário, agente de IA, certificado enviado): só
 * http(s) públicos, sem descompactar, com limite de tamanho e tempo.
 */
export async function safeGet(
  url: string,
  options: {
    maxBytes: number;
    timeoutMs?: number;
    allowHttp?: boolean;
    resolve?: Resolver;
    get?: RawHttpGet;
  }
): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw DomainError.validation('URL inválida');
  }
  const allowed = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(parsed.protocol)) throw DomainError.validation('A URL precisa ser https');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : await (options.resolve ?? dnsResolve)(host).catch(() => []);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw DomainError.validation('Endereço da URL não permitido');
  }
  const response = await (options.get ?? rawHttpGet)(parsed, {
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs ?? 10_000,
    address: addresses[0],
  });
  if (response.status < 200 || response.status >= 300) {
    throw DomainError.validation(`Não foi possível baixar (HTTP ${response.status})`);
  }
  return response.body;
}

export class SafeHttpsFetcher implements RemoteFileFetcher {
  constructor(
    private readonly get: RawHttpGet = rawHttpGet,
    private readonly resolve: Resolver = dnsResolve
  ) {}

  async fetch(url: string, maxBytes: number): Promise<Buffer> {
    try {
      return await safeGet(url, { maxBytes, resolve: this.resolve, get: this.get });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof ResponseTooLargeError)
        throw DomainError.validation('Imagem maior que o limite permitido');
      throw DomainError.validation(
        `Não foi possível baixar a imagem: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
