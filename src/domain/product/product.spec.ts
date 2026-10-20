import { describe, expect, it } from 'vitest';
import { createProduct, updateProduct } from './product.js';
import { createTaxProfile, taxProfileKey } from './tax-profile.js';

const now = new Date('2026-10-18T12:00:00Z');

describe('TaxProfile', () => {
  it('normaliza e aplica padrões', () => {
    const p = createTaxProfile({ nationalServiceCode: '01.07.01', nbsCode: '1.1501.30.00' });
    expect(p).toMatchObject({
      nationalServiceCode: '010701',
      nbsCode: '115013000',
      issTaxation: 'TAXABLE',
      issRetention: 'NONE',
    });
  });

  it.each([
    [{ nationalServiceCode: '0107' }, /6 dígitos/],
    [{ nationalServiceCode: '010701', municipalServiceCode: '12' }, /cTribMun/],
    [{ nationalServiceCode: '010701', nbsCode: '123' }, /cNBS/],
    [{ nationalServiceCode: '010701', issRateBps: 600 }, /entre 200 e 500/],
    [{ nationalServiceCode: '010701', issRateBps: 100 }, /entre 200 e 500/],
    [
      { nationalServiceCode: '010701', federalRetentions: { irrfRateBps: 5000 } },
      /federalRetentions/,
    ],
    [{ nationalServiceCode: '010701', approximateTaxRateBps: 12000 }, /approximateTaxRateBps/],
    [
      {
        nationalServiceCode: '010701',
        ibsCbs: { cst: '0', cClassTrib: '000001', operationIndicator: '100301' },
      },
      /ibsCbs/,
    ],
  ])('rejeita perfil inválido %#', (input, error) => {
    expect(() => createTaxProfile(input)).toThrow(error);
  });

  it('a chave diferencia qualquer mudança de tributação', () => {
    const a = createTaxProfile({ nationalServiceCode: '010701', issRateBps: 200 });
    const b = createTaxProfile({ nationalServiceCode: '010701', issRateBps: 300 });
    const c = createTaxProfile({ nationalServiceCode: '010701', issRateBps: 200 });
    const d = createTaxProfile({
      nationalServiceCode: '010701',
      issRateBps: 200,
      issRetention: 'TOMADOR',
    });
    expect(taxProfileKey(a)).not.toBe(taxProfileKey(b));
    expect(taxProfileKey(a)).toBe(taxProfileKey(c));
    expect(taxProfileKey(a)).not.toBe(taxProfileKey(d));
  });
});

describe('Product', () => {
  const input = { name: ' Consultoria ', taxProfile: { nationalServiceCode: '170101' } };

  it('cria com discriminação padrão igual ao nome', () => {
    const p = createProduct('p1', 't1', input, now);
    expect(p).toMatchObject({
      name: 'Consultoria',
      serviceDescription: 'Consultoria',
      active: true,
    });
  });

  it('valida campos', () => {
    expect(() => createProduct('p1', 't1', { ...input, name: ' ' }, now)).toThrow(/name/);
    expect(() => createProduct('p1', 't1', { ...input, defaultPriceCents: 1.5 }, now)).toThrow(
      /centavos/
    );
    expect(() =>
      createProduct('p1', 't1', { ...input, serviceDescription: 'x'.repeat(2001) }, now)
    ).toThrow(/2000/);
  });

  it('atualiza mesclando o perfil tributário', () => {
    const p = createProduct('p1', 't1', { ...input, defaultPriceCents: 1000 }, now);
    const later = new Date('2026-10-19T00:00:00Z');
    const u = updateProduct({ ...p, active: false }, { taxProfile: { issRateBps: 300 } }, later);
    expect(u.taxProfile).toMatchObject({ nationalServiceCode: '170101', issRateBps: 300 });
    expect(u).toMatchObject({
      defaultPriceCents: 1000,
      active: false,
      updatedAt: later,
      createdAt: now,
    });
  });
});
