import { describe, expect, it, vi } from 'vitest';
import { TestCompanyRegistry } from './test-company-registry.js';

describe('TestCompanyRegistry', () => {
  it('CNPJ de teste vira empresa fictícia de SBC; os demais vão para o cadastro real', async () => {
    const inner = { lookup: vi.fn(async () => null) };
    const registry = new TestCompanyRegistry(inner, ['99.000.001/0001-01']);

    expect(await registry.lookup('99000001000101')).toMatchObject({
      cnpj: '99000001000101',
      cityCode: '3548708',
      simplesNacional: true,
      mei: false,
      active: true,
    });
    expect(inner.lookup).not.toHaveBeenCalled();

    expect(await registry.lookup('11222333000181')).toBeNull();
    expect(inner.lookup).toHaveBeenCalledWith('11222333000181');
  });
});
