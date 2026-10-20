import { Invoice } from '../../src/domain/invoice/invoice.js';
import { createTaxProfile } from '../../src/domain/product/tax-profile.js';
import { createTenant, Tenant, TenantInput } from '../../src/domain/tenant/tenant.js';

export const NOW = new Date('2026-10-18T13:00:00.000Z');
export const TENANT_CNPJ = '11222333000181';

export function makeTenant(overrides: Partial<TenantInput> = {}): Tenant {
  return createTenant(
    'tenant-1',
    {
      cnpj: TENANT_CNPJ,
      legalName: 'Empresa Teste LTDA',
      municipalRegistration: '123456',
      taxRegime: 'SIMPLES_NACIONAL',
      simplesNacionalTaxRateBps: 600,
      email: 'financeiro@empresa.com.br',
      ...overrides,
    },
    'hash',
    NOW
  );
}

export function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    tenantId: 'tenant-1',
    saleId: 'sale-1',
    customer: {
      taxId: { kind: 'CPF', value: '52998224725' },
      name: 'Maria da Silva',
      email: 'maria@example.com',
      phone: '5511999998888',
    },
    items: [
      {
        productId: 'p1',
        productName: 'Consultoria',
        description: 'Consultoria em TI',
        quantity: 1,
        totalCents: 150000,
      },
    ],
    taxProfile: createTaxProfile({ nationalServiceCode: '010701', nbsCode: '115013000' }),
    serviceDescription: 'Consultoria em TI',
    amountCents: 150000,
    competenceDate: NOW,
    dps: { series: '1', number: 123, id: 'DPS354870821122233300018100001000000000000123' },
    status: 'PENDING',
    attempts: 0,
    deliveries: [],
    history: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
