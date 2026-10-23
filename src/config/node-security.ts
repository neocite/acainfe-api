/**
 * Versões mínimas do Node com as correções de segurança de 21/10/2026 (CVE-2026-111497 "Node2Shell":
 * RCE no decodificador Brotli do fetch; bypass de hostname no TLS; truncamento em dns.resolve).
 */
export const MIN_PATCHED_NODE: Record<number, string> = {
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
};

const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number);

/** O Node em execução tem as correções? Linha sem suporte (ex.: 23, 25) conta como vulnerável. */
export function nodeSecurityStatus(version: string): { patched: boolean; minimum?: string } {
  const [major, minor, patch] = parse(version);
  const minimum = MIN_PATCHED_NODE[major];
  if (!minimum) return { patched: false };
  const [, minMinor, minPatch] = parse(minimum);
  return {
    patched: minor > minMinor || (minor === minMinor && patch >= minPatch),
    minimum,
  };
}
