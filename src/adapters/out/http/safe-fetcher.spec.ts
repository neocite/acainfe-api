import { describe, expect, it, vi } from 'vitest';
import { HmacUploadLinks } from '../system.js';
import { isPrivateAddress, SafeHttpsFetcher } from './safe-fetcher.js';

const publicDns = async () => ['93.184.216.34'];

describe('SafeHttpsFetcher', () => {
  it('baixa imagem pública via https', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('img'), { status: 200 }));
    const fetcher = new SafeHttpsFetcher(fetchMock as unknown as typeof fetch, publicDns);
    expect((await fetcher.fetch('https://cdn.example.com/logo.png', 100)).toString()).toBe('img');
    expect((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe('error');
  });

  it('bloqueia http, endereços internos, URLs inválidas e arquivos grandes', async () => {
    const ok = vi.fn(async () => new Response(Buffer.alloc(200), { status: 200 }));
    const fetcher = new SafeHttpsFetcher(ok as unknown as typeof fetch, publicDns);
    await expect(fetcher.fetch('http://cdn.example.com/a.png', 100)).rejects.toThrow(/https/);
    await expect(fetcher.fetch('nao é url', 100)).rejects.toThrow(/inválida/);
    await expect(fetcher.fetch('https://169.254.169.254/latest', 100)).rejects.toThrow(
      /não permitido/
    );
    await expect(
      new SafeHttpsFetcher(ok as never, async () => ['10.0.0.5']).fetch(
        'https://intra.local/x',
        100
      )
    ).rejects.toThrow(/não permitido/);
    await expect(fetcher.fetch('https://cdn.example.com/big.png', 100)).rejects.toThrow(/limite/);
    const notFound = new SafeHttpsFetcher(
      (async () => new Response('', { status: 404 })) as never,
      publicDns
    );
    await expect(notFound.fetch('https://cdn.example.com/x.png', 100)).rejects.toThrow(/HTTP 404/);
  });

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
