import { lookup } from 'node:dns/promises';
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

export class SafeHttpsFetcher implements RemoteFileFetcher {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolve: (host: string) => Promise<string[]> = async (h) =>
      (await lookup(h, { all: true })).map((r) => r.address)
  ) {}

  async fetch(url: string, maxBytes: number): Promise<Buffer> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw DomainError.validation('URL inválida');
    }
    if (parsed.protocol !== 'https:') throw DomainError.validation('A URL precisa ser https');
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [host] : await this.resolve(host).catch(() => []);
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw DomainError.validation('Endereço da URL não permitido');
    }
    // Redirecionamentos são recusados: poderiam levar a um endereço interno depois da checagem.
    const response = await this.fetchImpl(parsed, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => {
      throw DomainError.validation(`Não foi possível baixar a imagem: ${e.message}`);
    });
    if (!response.ok)
      throw DomainError.validation(`Não foi possível baixar a imagem (HTTP ${response.status})`);
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      throw DomainError.validation('Imagem maior que o limite permitido');
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw DomainError.validation('Imagem maior que o limite permitido');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
