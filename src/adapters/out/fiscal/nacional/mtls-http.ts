import http from 'node:http';
import https from 'node:https';
import { CertificateMaterial } from '../../../../application/ports/fiscal-provider.js';
import { tlsClientCredentials } from '../../crypto/pfx.js';

export interface HttpResponse {
  status: number;
  body: unknown;
  raw: string;
}

export interface MtlsHttpClient {
  request(
    method: 'GET' | 'POST' | 'HEAD',
    url: string,
    certificate: CertificateMaterial,
    body?: unknown
  ): Promise<HttpResponse>;
}

/** Erro de transporte (rede, TLS, timeout) — distinto de respostas HTTP de erro. */
export class TransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/**
 * Cliente HTTP com TLS mútuo usando o próprio A1 do prestador (exigência da Sefin/ADN).
 * URLs http:// são aceitas apenas para testes locais (fake Sefin).
 */
export class NodeMtlsHttpClient implements MtlsHttpClient {
  constructor(private readonly timeoutMs = 30_000) {}

  request(
    method: 'GET' | 'POST' | 'HEAD',
    url: string,
    certificate: CertificateMaterial,
    body?: unknown
  ): Promise<HttpResponse> {
    const target = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const isHttps = target.protocol === 'https:';
    const options: https.RequestOptions = {
      method,
      headers: {
        Accept: 'application/json',
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: this.timeoutMs,
      ...(isHttps ? { ...tlsClientCredentials(certificate), minVersion: 'TLSv1.2' as const } : {}),
    };
    return new Promise((resolve, reject) => {
      const req = (isHttps ? https : http).request(target, options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            /* corpo não-JSON (ex.: HTML de erro do balanceador) */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
        res.on('error', (e) => reject(new TransportError(`Erro lendo resposta: ${e.message}`, e)));
      });
      req.on('timeout', () => req.destroy(new TransportError(`Timeout após ${this.timeoutMs}ms`)));
      req.on('error', (e) =>
        reject(
          e instanceof TransportError ? e : new TransportError(`Falha de conexão: ${e.message}`, e)
        )
      );
      if (payload) req.write(payload);
      req.end();
    });
  }
}
