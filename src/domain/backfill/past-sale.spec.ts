import { describe, expect, it } from 'vitest';
import { currentPeriod, markAlreadyIssued, PastSale } from './past-sale.js';

const base: PastSale = {
  id: 'p',
  tenantId: 't',
  source: 'ABACATEPAY',
  kind: 'CHECKOUT',
  externalId: 'bill_1',
  paidAt: new Date('2026-10-01T00:00:00Z'),
  period: '2026-09',
  amountCents: 100,
  items: [],
  customer: {},
  status: 'AVAILABLE',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PastSale', () => {
  it('período corrente em Brasília e regras de marcação', () => {
    expect(currentPeriod(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10');
    expect(markAlreadyIssued(base, true, new Date()).status).toBe('ALREADY_ISSUED');
    expect(() => markAlreadyIssued({ ...base, status: 'IMPORTED' }, true, new Date())).toThrow(
      /emitida/
    );
    expect(() => markAlreadyIssued({ ...base, status: 'REFUNDED' }, true, new Date())).toThrow(
      /estornada/
    );
  });
});
