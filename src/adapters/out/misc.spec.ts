import { describe, expect, it, vi } from 'vitest';
import { makeInvoice, makeTenant } from '../../../test/support/fixtures.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import { loadEnv, parseMasterKeys } from '../../config/env.js';
import { StaticServiceCodeCatalog } from './catalog/static-service-code-catalog.js';
import { PdfmakeDanfseRenderer } from './pdf/pdfmake-danfse-renderer.js';
import { HmacDocumentLinks } from './system.js';
import { UazapiWhatsappSender } from './whatsapp/uazapi-whatsapp-sender.js';

describe('catálogo de códigos de serviço', () => {
  const catalog = new StaticServiceCodeCatalog();
  it('busca sem acento e por código', () => {
    expect(catalog.search('informatica suporte', 3)[0].nationalServiceCode).toBe('010701');
    expect(catalog.search('17.19', 5)[0].description).toMatch(/Contabilidade/);
    expect(catalog.search('', 5)).toHaveLength(5);
    expect(catalog.find('171401')!.description).toBe('Advocacia');
    expect(catalog.find('999999')).toBeUndefined();
  });
});

describe('links assinados', () => {
  it('assina e verifica', () => {
    const links = new HmacDocumentLinks('https://api.x/', 'segredo-super-secreto-123456');
    const url = links.pdfUrl('inv-1')!;
    const sig = new URL(url).searchParams.get('sig')!;
    expect(url).toMatch(/^https:\/\/api\.x\/v1\/public\/invoices\/inv-1\/pdf\?sig=/);
    expect(links.verify('inv-1', sig)).toBe(true);
    expect(links.verify('inv-2', sig)).toBe(false);
    expect(new HmacDocumentLinks(undefined, 's').pdfUrl('x')).toBeUndefined();
  });
});

describe('uazapi', () => {
  it('envia documento com header token e URL do PDF', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const sender = new UazapiWhatsappSender(
      'https://inst.uazapi.com/',
      'tok',
      fetchMock as unknown as typeof fetch
    );
    await sender.sendDocument({
      phone: '5511999998888',
      caption: 'NFS-e',
      fileName: 'n.pdf',
      file: Buffer.from('pdf'),
      fileUrl: 'https://x/pdf',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://inst.uazapi.com/send/media');
    expect((init.headers as Record<string, string>).token).toBe('tok');
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: '5511999998888',
      type: 'document',
      file: 'https://x/pdf',
      docName: 'n.pdf',
    });
  });

  it('usa base64 sem URL e propaga erro legível', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 })
    );
    const sender = new UazapiWhatsappSender(
      'https://inst.uazapi.com',
      'tok',
      fetchMock as unknown as typeof fetch
    );
    await expect(
      sender.sendDocument({ phone: '55', caption: '', fileName: 'n.pdf', file: Buffer.from('pdf') })
    ).rejects.toThrow(/HTTP 401: Invalid token/);
    expect(
      JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).file
    ).toBe(Buffer.from('pdf').toString('base64'));
  });
});

describe('DANFSe', () => {
  it('gera PDF para nota emitida e cancelada', async () => {
    const renderer = new PdfmakeDanfseRenderer();
    const pdf = await renderer.render(
      makeInvoice({ status: 'ISSUED', nfse: sampleNfse('5') }),
      makeTenant()
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const cancelled = await renderer.render(
      makeInvoice({
        status: 'CANCELLED',
        nfse: sampleNfse('5'),
        cancellation: { reasonCode: '1', reason: 'Erro', at: new Date() },
      }),
      makeTenant({ environment: 'PRODUCTION' })
    );
    expect(cancelled.length).toBeGreaterThan(1000);
    await expect(renderer.render(makeInvoice(), makeTenant())).rejects.toThrow(/não emitida/);
    // 1x1 PNG transparente
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    );
    const withLogo = await renderer.render(
      makeInvoice({ status: 'ISSUED', nfse: sampleNfse('5') }),
      makeTenant(),
      {
        logo: { contentType: 'image/png', data: png },
      }
    );
    expect(withLogo.length).toBeGreaterThan(pdf.length);
    const foreign = await renderer.render(
      makeInvoice({
        status: 'ISSUED',
        nfse: sampleNfse('6'),
        customer: { name: 'John', foreign: { countryCode: 'US', nif: '123' } },
      }),
      makeTenant({ approximateTaxes: { rateBps: 1553, source: 'IBPT' } })
    );
    expect(foreign.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('configuração', () => {
  const base = {
    MONGODB_URI: 'mongodb://x',
    ADMIN_API_KEY: 'a'.repeat(24),
    MASTER_KEYS: 'k1:abc',
    LINK_SIGNING_SECRET: 's'.repeat(24),
  };
  it('aplica padrões e valida', () => {
    const env = loadEnv({ ...base, JOBS_ENABLED: 'false' });
    expect(env).toMatchObject({
      PORT: 3000,
      JOBS_ENABLED: false,
      SEFIN_HOMOLOGATION_URL: expect.stringContaining('producaorestrita'),
    });
    expect(() => loadEnv({})).toThrow(/MONGODB_URI/);
  });
  it('lê master keys', () => {
    expect(parseMasterKeys('k1:aaa, k2:bbb')).toEqual({ k1: 'aaa', k2: 'bbb' });
    expect(() => parseMasterKeys('semdoispontos')).toThrow(/formato/);
  });
});
