/**
 * Política de retentativa para indisponibilidade da prefeitura/Sefin.
 * Escalona até ~12h entre tentativas e desiste após MAX_ATTEMPTS (≈ 5 dias), quando a nota vai a FAILED
 * e pode ser reprocessada manualmente.
 */
const DELAYS_MS = [
  30_000,
  2 * 60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 3_600_000,
  4 * 3_600_000,
  8 * 3_600_000,
];
const MAX_DELAY_MS = 12 * 3_600_000;
export const MAX_ATTEMPTS = 18;

export function nextRetryDelayMs(attempt: number): number {
  return attempt <= DELAYS_MS.length ? DELAYS_MS[attempt - 1] : MAX_DELAY_MS;
}

export const shouldGiveUp = (attempt: number): boolean => attempt >= MAX_ATTEMPTS;
