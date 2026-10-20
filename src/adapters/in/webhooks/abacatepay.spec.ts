import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ABACATEPAY_PUBLIC_HMAC_KEY,
  abacatePayChargeId,
  isAbacatePayRefund,
  mapAbacatePayPayload,
  verifyAbacatePaySignature,
} from './abacatepay.service.js';

describe('AbacatePay', () => {
  it('mapeia checkout.completed (v2)', () => {
    const mapped = mapAbacatePayPayload({
      event: 'checkout.completed',
      data: {
        checkout: {
          id: 'bill_1',
          amount: 10000,
          paidAmount: 10000,
          items: [{ id: 'prod_a', quantity: 2 }],
        },
        customer: { name: 'João', email: 'joao@x.com', taxId: '123.***.***-**' },
      },
    });
    expect(mapped).toMatchObject({
      source: 'ABACATEPAY',
      externalId: 'bill_1',
      totalCents: 10000,
      items: [{ productExternalId: 'prod_a', quantity: 2 }],
      customer: { name: 'João', email: 'joao@x.com', taxId: '123.***.***-**' },
    });
  });

  it('mapeia billing.paid (v1) com preço por item e celular', () => {
    const mapped = mapAbacatePayPayload({
      event: 'billing.paid',
      data: {
        billing: {
          id: 'bill_v1',
          amount: 2990,
          products: [{ externalId: 'plan-pro', quantity: 1, price: 2990 }],
          customer: {
            metadata: { name: 'Ana', email: 'ana@x.com', cellphone: '11999998888', taxId: '' },
          },
        },
      },
    });
    expect(mapped).toMatchObject({
      externalId: 'bill_v1',
      items: [{ productExternalId: 'plan-pro', unitPriceCents: 2990 }],
      customer: { phone: '11999998888', taxId: undefined },
    });
  });

  it('ignora eventos que não geram nota', () => {
    expect(mapAbacatePayPayload({ event: 'checkout.refunded' })).toHaveProperty('ignored');
    expect(mapAbacatePayPayload({ event: 'billing.paid', data: { pixQrCode: {} } })).toHaveProperty(
      'ignored'
    );
    expect(
      mapAbacatePayPayload({ event: 'checkout.completed', data: { checkout: { items: [] } } })
    ).toHaveProperty('ignored');
  });

  it('verifica HMAC do corpo bruto', () => {
    const body = Buffer.from('{"event":"checkout.completed"}');
    const sig = createHmac('sha256', ABACATEPAY_PUBLIC_HMAC_KEY).update(body).digest('base64');
    expect(verifyAbacatePaySignature(body, sig)).toBe(true);
    expect(verifyAbacatePaySignature(Buffer.from('{}'), sig)).toBe(false);
    expect(verifyAbacatePaySignature(body, undefined)).toBe(false);
  });

  it('identifica estornos e o id da cobrança', () => {
    expect(isAbacatePayRefund({ event: 'checkout.refunded' })).toBe(true);
    expect(isAbacatePayRefund({ event: 'checkout.lost' })).toBe(true);
    expect(isAbacatePayRefund({ event: 'checkout.disputed' })).toBe(false);
    expect(abacatePayChargeId({ data: { checkout: { id: 'bill_1' } } })).toBe('bill_1');
    expect(abacatePayChargeId({ data: { billing: { id: 'bill_2' } } })).toBe('bill_2');
    expect(abacatePayChargeId({})).toBeUndefined();
  });
});
