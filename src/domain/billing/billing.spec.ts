import { describe, expect, it } from 'vitest';
import { applyPayment, BillingCharge, newAccount, summarize } from './billing.js';

const NOW = new Date('2026-10-20T12:00:00Z');
const day = 86_400_000;
const charge = (id: string, daysAgo: number, amount = 80): BillingCharge => ({
  id,
  tenantId: 't',
  invoiceId: `inv-${id}`,
  amountCents: amount,
  status: 'OPEN',
  createdAt: new Date(NOW.getTime() - daysAgo * day),
});

describe('cobrança', () => {
  it('resume o saldo, prazo de pausa e respeita o Pix mínimo', () => {
    const s = summarize(newAccount('t', NOW), [charge('a', 3), charge('b', 1)], NOW, 7, 80);
    expect(s).toMatchObject({
      openCents: 160,
      openCharges: 2,
      amountDueCents: 160,
      overdue: false,
      pricePerInvoiceCents: 80,
    });
    expect(s.blocksAt).toEqual(new Date(NOW.getTime() + 4 * day));
    expect(summarize(newAccount('t', NOW), [charge('a', 1)], NOW, 7, 80).amountDueCents).toBe(100);
    expect(
      summarize({ ...newAccount('t', NOW), creditCents: 20 }, [charge('a', 1)], NOW, 7, 80)
        .amountDueCents
    ).toBe(100);
    expect(
      summarize({ ...newAccount('t', NOW), creditCents: 80 }, [charge('a', 1)], NOW, 7, 80)
        .amountDueCents
    ).toBe(0);
    expect(summarize(newAccount('t', NOW), [charge('a', 8)], NOW, 7, 80).overdue).toBe(true);
    expect(
      summarize({ ...newAccount('t', NOW), pricePerInvoiceCents: 50 }, [], NOW, 7, 80)
    ).toMatchObject({
      openCents: 0,
      amountDueCents: 0,
      overdue: false,
      pricePerInvoiceCents: 50,
    });
  });

  it('aplica pagamento nas mais antigas e guarda a sobra como crédito', () => {
    const r = applyPayment([charge('novo', 1), charge('velho', 5)], 100, 0);
    expect(r.settled.map((c) => c.id)).toEqual(['velho']);
    expect(r.creditCents).toBe(20);
    expect(applyPayment([charge('a', 1)], 0, 80).settled).toHaveLength(1);
    expect(() => applyPayment([], -1, 0)).toThrow(/inválido/);
  });
});
