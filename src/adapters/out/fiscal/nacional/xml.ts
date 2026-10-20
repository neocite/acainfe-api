import { bpsToDecimal, centsToPlainDecimal } from '../../../../domain/shared/money.js';
export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse';
export const LAYOUT_VERSION = '1.01';

export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Remove caracteres de controle e normaliza espaços — a Sefin rejeita quebras inesperadas em alguns campos. */
export const cleanText = (value: string, max: number): string =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, max);

type Child = string | false | null | undefined;

/** Monta um elemento; filhos falsy são omitidos (campos opcionais). Valor string é escapado. */
export function el(
  name: string,
  content: string | number | Child[] | undefined,
  attrs?: Record<string, string>
): string {
  if (content === undefined) return '';
  const attrText = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
        .join('')
    : '';
  const body = Array.isArray(content)
    ? content.filter(Boolean).join('')
    : escapeXml(String(content));
  return `<${name}${attrText}>${body}</${name}>`;
}

const BRT_OFFSET_MS = -3 * 3_600_000;

/** AAAA-MM-DDThh:mm:ss-03:00 (Brasília, sem horário de verão desde 2019). */
export function formatDateTimeBrt(date: Date): string {
  return `${new Date(date.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 19)}-03:00`;
}

export function formatDateBrt(date: Date): string {
  return new Date(date.getTime() + BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Centavos (inteiro) → "1500.00", sem ponto flutuante. */
export const decimal2 = (cents: number): string => centsToPlainDecimal(cents);

/** Pontos-base (inteiro) → "2.01". */
export const rate2 = (bps: number): string => bpsToDecimal(bps);
