import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HmacUploadLinks } from '../system.js';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { brotliCompressSync } from 'node:zlib';
import {
  CompressedResponseError,
  isPrivateAddress,
  RawHttpGet,
  rawHttpGet,
  ResponseTooLargeError,
  safeGet,
  SafeHttpsFetcher,
} from './safe-fetcher.js';

const publicDns = async () => ['93.184.216.34'];

describe('SafeHttpsFetcher', () => {
  const ok = (size = 3): RawHttpGet =>
    vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.alloc(size, 'i') }));

  it('baixa imagem pública via https, conectando no IP já verificado', async () => {
    const get = ok();
    const fetcher = new SafeHttpsFetcher(get, publicDns);
    expect((await fetcher.fetch('https://cdn.example.com/logo.png', 100)).toString()).toBe('iii');
    expect(vi.mocked(get).mock.calls[0][1]).toMatchObject({
      address: '93.184.216.34',
      maxBytes: 100,
    });
  });

  it('bloqueia http, endereços internos, URLs inválidas, arquivos grandes e erro HTTP', async () => {
    const fetcher = new SafeHttpsFetcher(ok(), publicDns);
    await expect(fetcher.fetch('http://cdn.example.com/a.png', 100)).rejects.toThrow(/https/);
    await expect(fetcher.fetch('nao é url', 100)).rejects.toThrow(/inválida/);
    await expect(fetcher.fetch('https://169.254.169.254/latest', 100)).rejects.toThrow(
      /não permitido/
    );
    await expect(
      new SafeHttpsFetcher(ok(), async () => ['10.0.0.5']).fetch('https://intra.local/x', 100)
    ).rejects.toThrow(/não permitido/);
    const tooBig: RawHttpGet = async () => {
      throw new ResponseTooLargeError('x');
    };
    await expect(
      new SafeHttpsFetcher(tooBig, publicDns).fetch('https://cdn.example.com/big.png', 100)
    ).rejects.toThrow(/limite/);
    const notFound: RawHttpGet = async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) });
    await expect(
      new SafeHttpsFetcher(notFound, publicDns).fetch('https://cdn.example.com/x.png', 100)
    ).rejects.toThrow(/HTTP 404/);
  });

  it('safeGet aceita http só quando permitido (AIA da ICP-Brasil)', async () => {
    await expect(
      safeGet('http://ac.example.com/a.p7b', { maxBytes: 10, resolve: publicDns, get: ok() })
    ).rejects.toThrow(/https/);
    expect(
      (
        await safeGet('http://ac.example.com/a.p7b', {
          maxBytes: 10,
          allowHttp: true,
          resolve: publicDns,
          get: ok(),
        })
      ).length
    ).toBe(3);
  });
});

describe('rawHttpGet (sem descompactação: CVE-2026-111497)', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/br') {
        res.writeHead(200, { 'content-encoding': 'br' });
        res.end(brotliCompressSync(Buffer.from('payload')));
      } else if (req.url === '/big') {
        res.end(Buffer.alloc(5000));
      } else {
        res.end(`ok accept-encoding=${req.headers['accept-encoding']}`);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // O host não existe: só funciona porque a conexão vai direto ao endereço já verificado.
  const url = (path: string) => new URL(`http://nao-existe.invalid:${port}${path}`);
  const opts = { maxBytes: 1000, timeoutMs: 5000, address: '127.0.0.1' };

  it('pede sem compressão e conecta no endereço informado', async () => {
    const res = await rawHttpGet(url('/'), opts);
    expect(res.body.toString()).toBe('ok accept-encoding=identity');
  });

  it('recusa resposta compactada sem descompactar', async () => {
    await expect(rawHttpGet(url('/br'), opts)).rejects.toBeInstanceOf(CompressedResponseError);
  });

  it('corta resposta maior que o limite', async () => {
    await expect(rawHttpGet(url('/big'), opts)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('endereços privados', () => {
  it('classifica endereços privados', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
});

describe('HmacUploadLinks', () => {
  it('gera, verifica e expira tokens', () => {
    let now = 1_000_000;
    const links = new HmacUploadLinks('https://api.x', 'segredo-de-teste-123456789', () => now);
    const { url } = links.certificateUploadUrl('tenant-1', 60_000)!;
    const token = url.split('/').pop()!;
    expect(links.verify(token)).toBe('tenant-1');
    expect(links.verify(token.replace('tenant-1', 'tenant-2'))).toBeNull();
    expect(links.verify('lixo')).toBeNull();
    now += 61_000;
    expect(links.verify(token)).toBeNull();
    expect(new HmacUploadLinks(undefined, 's').certificateUploadUrl('t', 1)).toBeUndefined();
  });
});
