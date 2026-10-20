import { describe, expect, it } from 'vitest';
import {
  isValidCnpj,
  isValidCpf,
  normalizeBrazilianPhone,
  normalizeEmail,
  parseCnpj,
  parseTaxId,
} from './document.js';
import {
  allocateProportionally,
  applyBps,
  assertBps,
  bpsToDecimal,
  formatBps,
  assertCents,
  centsToDecimal,
  formatBRL,
} from './money.js';

describe('documentos', () => {
  it('valida CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });

  it('valida CNPJ', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });

  it('identifica o tipo de documento', () => {
    expect(parseTaxId('529.982.247-25')).toEqual({ kind: 'CPF', value: '52998224725' });
    expect(parseTaxId('11.222.333/0001-81')).toEqual({ kind: 'CNPJ', value: '11222333000181' });
    expect(() => parseTaxId('123')).toThrow(/inválido/);
    expect(() => parseCnpj('52998224725')).toThrow(/CNPJ inválido/);
  });

  it('normaliza telefone para 55DDDNUMERO', () => {
    expect(normalizeBrazilianPhone('(11) 99999-8888')).toBe('5511999998888');
    expect(normalizeBrazilianPhone('+55 11 3333-4444')).toBe('551133334444');
    expect(normalizeBrazilianPhone('005511999998888')).toBe('5511999998888');
    expect(() => normalizeBrazilianPhone('123')).toThrow(/Telefone/);
  });

  it('normaliza e-mail', () => {
    expect(normalizeEmail(' Maria@Example.COM ')).toBe('maria@example.com');
    expect(() => normalizeEmail('maria@')).toThrow(/E-mail/);
  });
});

describe('dinheiro', () => {
  it('formata e converte centavos', () => {
    expect(centsToDecimal(150000)).toBe('1500.00');
    expect(formatBRL(123456)).toMatch(/1\.234,56/);
    expect(applyBps(10000, 250)).toBe(250);
    expect(applyBps(19700, 1553)).toBe(3059); // R$ 197,00 × 15,53% = R$ 30,59 (como no eNotas)
    expect(bpsToDecimal(201)).toBe('2.01');
    expect(bpsToDecimal(600)).toBe('6.00');
    expect(formatBps(1553)).toBe('15,53');
    expect(centsToDecimal(8220)).toBe('82.20');
    expect(assertBps(201, 'x')).toBe(201);
    expect(() => assertBps(2.01, 'x')).toThrow(/inteiro em pontos-base/);
    expect(() => assertBps(10_001, 'x')).toThrow(/entre 0 e 10000/);
  });

  it('rejeita valores não inteiros ou negativos', () => {
    expect(() => assertCents(10.5)).toThrow(/centavos/);
    expect(() => assertCents(-1)).toThrow(/centavos/);
    expect(assertCents(0)).toBe(0);
  });

  it('rateia preservando a soma exata', () => {
    expect(allocateProportionally(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocateProportionally(1000, [3000, 1000])).toEqual([750, 250]);
    expect(allocateProportionally(101, [0, 0])).toEqual([51, 50]);
    const shares = allocateProportionally(99999, [7, 13, 29]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(99999);
  });
});
