import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateTestPfx } from '../../../../test/support/test-certificate.js';
import { AesGcmEnvelopeCipher } from './aes-gcm-cipher.js';
import { ForgeCertificateParser } from './forge-certificate-parser.js';
import { openPfx, tlsClientCredentials } from './pfx.js';

const key = () => randomBytes(32).toString('base64');

describe('AesGcmEnvelopeCipher', () => {
  it('cifra e decifra com DEK aleatória por segredo', () => {
    const cipher = new AesGcmEnvelopeCipher('k1', { k1: key() });
    const a = cipher.encrypt(Buffer.from('segredo'));
    const b = cipher.encrypt(Buffer.from('segredo'));
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.k1.')).toBe(true);
    expect(cipher.decrypt(a).toString()).toBe('segredo');
  });

  it('suporta rotação de master key mantendo leitura dos antigos', () => {
    const k1 = key();
    const old = new AesGcmEnvelopeCipher('k1', { k1 }).encrypt(Buffer.from('antigo'));
    const rotated = new AesGcmEnvelopeCipher('k2', { k1, k2: key() });
    expect(rotated.decrypt(old).toString()).toBe('antigo');
    expect(rotated.encrypt(Buffer.from('x')).startsWith('v1.k2.')).toBe(true);
  });

  it('detecta adulteração e configuração inválida', () => {
    const cipher = new AesGcmEnvelopeCipher('k1', { k1: key() });
    const sealed = cipher.encrypt(Buffer.from('dado'));
    const parts = sealed.split('.');
    const tampered = Buffer.from(parts[3], 'base64url');
    tampered[tampered.length - 1] ^= 1;
    expect(() =>
      cipher.decrypt([...parts.slice(0, 3), tampered.toString('base64url')].join('.'))
    ).toThrow();
    expect(() => cipher.decrypt('lixo')).toThrow(/Formato/);
    expect(() => cipher.decrypt('v1.k9.a.b')).toThrow(/indisponível/);
    expect(() => new AesGcmEnvelopeCipher('k1', { k1: 'curta' })).toThrow(/32 bytes/);
    expect(() => new AesGcmEnvelopeCipher('k2', { k1: key() })).toThrow(/não configurada/);
  });
});

describe('certificado A1', () => {
  it('extrai CNPJ do SAN ICP-Brasil e metadados', () => {
    const { pfx, password } = generateTestPfx({
      cnpj: '11444777000161',
      commonName: 'SEM CNPJ NO CN',
    });
    const meta = new ForgeCertificateParser().parse(pfx, password);
    expect(meta.cnpj).toBe('11444777000161');
    expect(meta.subjectName).toContain('CN=SEM CNPJ NO CN');
    expect(meta.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('extrai PEMs e base64 sem quebras para o XMLDSig', () => {
    const { pfx, password } = generateTestPfx();
    const contents = openPfx(pfx, password);
    expect(contents.privateKeyPem).toContain('PRIVATE KEY');
    expect(contents.certificateBase64).not.toMatch(/\s/);
  });

  it('rejeita arquivo inválido', () => {
    expect(() => openPfx(Buffer.from('não é pfx'), 'x')).toThrow(/Não foi possível abrir/);
  });
});

describe('credenciais do TLS mútuo', () => {
  it('converte o .pfx em PEM aceito pelo TLS do Node (A1 com cifra antiga)', async () => {
    const { createSecureContext } = await import('node:tls');
    const { pfx, password } = generateTestPfx();
    const credentials = tlsClientCredentials({ pfx, password });
    expect(credentials.key).toMatch(/BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY/);
    expect(credentials.cert).toMatch(/BEGIN CERTIFICATE/);
    expect(() => createSecureContext(credentials)).not.toThrow();
    // Mesmo .pfx: reaproveita a conversão.
    expect(tlsClientCredentials({ pfx, password })).toBe(credentials);
  });
});
