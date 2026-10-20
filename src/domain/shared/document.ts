import { DomainError } from './domain-error.js';

export const onlyDigits = (value: string): string => value.replace(/\D/g, '');

const allSameDigits = (digits: string): boolean => /^(\d)\1+$/.test(digits);

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || allSameDigits(cpf)) return false;
  const check = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(cpf[9]) && check(10) === Number(cpf[10]);
}

export function isValidCnpj(value: string): boolean {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || allSameDigits(cnpj)) return false;
  const check = (len: number): number => {
    const weights =
      len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(cnpj[i]) * w, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(cnpj[12]) && check(13) === Number(cnpj[13]);
}

export type TaxIdKind = 'CPF' | 'CNPJ';

export interface TaxId {
  kind: TaxIdKind;
  value: string;
}

export function parseTaxId(raw: string): TaxId {
  const digits = onlyDigits(raw);
  if (digits.length === 11 && isValidCpf(digits)) return { kind: 'CPF', value: digits };
  if (digits.length === 14 && isValidCnpj(digits)) return { kind: 'CNPJ', value: digits };
  throw DomainError.validation(`CPF/CNPJ inválido: ${raw}`);
}

export function parseCnpj(raw: string): string {
  const digits = onlyDigits(raw);
  if (!isValidCnpj(digits)) throw DomainError.validation(`CNPJ inválido: ${raw}`);
  return digits;
}

/** Normaliza telefone brasileiro para o formato internacional só com dígitos (55 + DDD + número). */
export function normalizeBrazilianPhone(raw: string): string {
  let digits = onlyDigits(raw);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!/^55\d{10,11}$/.test(digits)) throw DomainError.validation(`Telefone inválido: ${raw}`);
  return digits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw DomainError.validation(`E-mail inválido: ${raw}`);
  return email;
}
