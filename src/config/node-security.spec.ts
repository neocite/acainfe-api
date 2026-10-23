import { describe, expect, it } from 'vitest';
import { nodeSecurityStatus } from './node-security.js';

describe('versão do Node com as correções de 21/10/2026', () => {
  it('compara com o mínimo da linha', () => {
    expect(nodeSecurityStatus('v22.23.3')).toEqual({ patched: false, minimum: '22.23.4' });
    expect(nodeSecurityStatus('v22.23.4')).toEqual({ patched: true, minimum: '22.23.4' });
    expect(nodeSecurityStatus('22.24.0').patched).toBe(true);
    expect(nodeSecurityStatus('v26.5.0')).toEqual({ patched: false, minimum: '26.12.1' });
    expect(nodeSecurityStatus('v24.22.1').patched).toBe(true);
    expect(nodeSecurityStatus('v23.11.0')).toEqual({ patched: false });
  });
});
