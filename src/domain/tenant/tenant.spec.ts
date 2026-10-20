import { describe, expect, it } from 'vitest';
import { assertCertificateUsable, daysUntilExpiry } from '../certificate/certificate.js';
import { createTenant, isSimplesNacional } from './tenant.js';

const now = new Date('2026-10-18T12:00:00Z');
const base = {
  cnpj: '11.222.333/0001-81',
  legalName: 'Empresa',
  municipalRegistration: '12.345-6',
  taxRegime: 'SIMPLES_NACIONAL' as const,
  email: 'A@B.com',
};

describe('Tenant', () => {
  it('cria com padrões para SBC e homologação', () => {
    const t = createTenant('t1', base, 'h', now);
    expect(t).toMatchObject({
      cnpj: '11222333000181',
      municipalRegistration: '123456',
      cityCode: '3548708',
      environment: 'HOMOLOGATION',
      simplesNacionalApuration: 1,
      sendMunicipalRegistration: true,
      dpsSeries: '1',
      lastDpsNumber: 0,
      email: 'a@b.com',
    });
  });

  it('não define apuração do SN para outros regimes', () => {
    expect(
      createTenant('t1', { ...base, taxRegime: 'LUCRO_PRESUMIDO' }, 'h', now)
        .simplesNacionalApuration
    ).toBeUndefined();
  });

  it.each([
    [{ cityCode: '123' }, /IBGE/],
    [{ legalName: '' }, /legalName/],
    [{ municipalRegistration: 'abc' }, /municipalRegistration/],
    [{ dpsSeries: '123456' }, /dpsSeries/],
    [{ taxRegime: 'XYZ' }, /taxRegime/],
    [{ simplesNacionalApuration: 4 }, /simplesNacionalApuration/],
    [{ simplesNacionalTaxRateBps: 4000 }, /simplesNacionalTaxRateBps/],
    [{ cnpj: '123' }, /CNPJ/],
  ])('valida %#', (patch, error) => {
    expect(() => createTenant('t1', { ...base, ...(patch as object) }, 'h', now)).toThrow(error);
  });

  it('identifica optantes do Simples', () => {
    expect(isSimplesNacional('MEI')).toBe(true);
    expect(isSimplesNacional('LUCRO_REAL')).toBe(false);
  });
});

describe('Certificate', () => {
  const meta = {
    subjectName: 'CN=X',
    cnpj: '11222333000181',
    issuer: 'AC',
    serialNumber: '1',
    notBefore: new Date('2026-01-01'),
    notAfter: new Date('2026-11-17T12:00:00Z'),
  };

  it('aceita certificado válido da matriz ou filial', () => {
    expect(() => assertCertificateUsable(meta, '11222333000181', now)).not.toThrow();
    expect(() => assertCertificateUsable(meta, '11222333000262', now)).not.toThrow();
    expect(daysUntilExpiry(meta, now)).toBe(30);
  });

  it('rejeita vencido, futuro ou de outro CNPJ', () => {
    expect(() =>
      assertCertificateUsable({ ...meta, notAfter: new Date('2026-10-01') }, '11222333000181', now)
    ).toThrow(/vencido/);
    expect(() =>
      assertCertificateUsable({ ...meta, notBefore: new Date('2026-12-01') }, '11222333000181', now)
    ).toThrow(/ainda não/);
    expect(() => assertCertificateUsable(meta, '11444777000161', now)).toThrow(/outro CNPJ/);
  });
});
