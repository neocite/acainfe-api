import { DomainError } from './domain-error.js';

/** Valores monetários sempre em centavos (inteiros) para evitar erros de ponto flutuante. */
export type Cents = number;

export function assertCents(value: number, field = 'valor'): Cents {
  if (!Number.isInteger(value) || value < 0) {
    throw DomainError.validation(`${field} deve ser inteiro em centavos e não negativo`, { value });
  }
  return value;
}

export const centsToDecimal = (cents: Cents): string => centsToPlainDecimal(cents);

export const formatBRL = (cents: Cents): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

/**
 * Percentuais também são inteiros: pontos-base (centésimos de ponto percentual).
 * 2,01% = 201 bps; 15,53% = 1553 bps; 100% = 10000 bps.
 */
export type Bps = number;

export function assertBps(value: number, field: string, max = 10_000, min = 0): Bps {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw DomainError.validation(
      `${field} deve ser inteiro em pontos-base (centésimos de %: 2,01% = 201) entre ${min} e ${max}`,
      { value }
    );
  }
  return value;
}

/** Aplica percentual em pontos-base sobre centavos, arredondando meio-para-cima (só aritmética inteira na entrada). */
export const applyBps = (cents: Cents, bps: Bps): Cents => Math.round((cents * bps) / 10_000);

/** 201 → "2.01" (formato decimal exigido por XML/planilhas). */
export const bpsToDecimal = (bps: Bps): string =>
  `${Math.trunc(bps / 100)}.${String(Math.abs(bps % 100)).padStart(2, '0')}`;

/** 201 → "2,01" (exibição em português). */
export const formatBps = (bps: Bps): string => bpsToDecimal(bps).replace('.', ',');

/** 8220 → "82.20" sem passar por ponto flutuante. */
export const centsToPlainDecimal = (cents: Cents): string =>
  `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;

/**
 * Distribui um total entre pesos, preservando a soma exata (maior resto).
 * Usado quando o gateway informa só o total pago e precisamos ratear por item.
 */
export function allocateProportionally(total: Cents, weights: number[]): Cents[] {
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    const base = Math.floor(total / weights.length);
    const result = weights.map(() => base);
    for (let i = 0; i < total - base * weights.length; i++) result[i] += 1;
    return result;
  }
  const raw = weights.map((w) => (total * w) / weightSum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  return floors;
}
