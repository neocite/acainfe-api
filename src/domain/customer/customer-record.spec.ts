import { describe, expect, it } from 'vitest';
import { makeInvoice, NOW } from '../../../test/support/fixtures.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import {
  abortBeforeIssue,
  markCancelled,
  recordCancellationFailure,
  syncIssued,
} from '../invoice/invoice.js';
import { createSale, requestRefund } from '../sale/sale.js';
import { validateLogo } from '../tenant/logo.js';
import { createCustomerRecord, mergeCustomer, updateCustomerRecord } from './customer-record.js';

describe('CustomerRecord', () => {
  it('cria, atualiza e mescla', () => {
    const r = createCustomerRecord(
      'c1',
      't1',
      { name: 'Ana', email: 'ANA@x.com', externalId: ' cust_9 ' },
      NOW
    );
    expect(r).toMatchObject({ email: 'ana@x.com', externalId: 'cust_9' });
    const later = new Date(NOW.getTime() + 1000);
    expect(updateCustomerRecord(r, { taxId: '52998224725' }, later)).toMatchObject({
      taxId: { value: '52998224725' },
      updatedAt: later,
      createdAt: NOW,
    });
    expect(mergeCustomer({ name: 'A', email: 'a@x.com' }, { email: 'b@x.com' })).toEqual({
      name: 'A',
      email: 'b@x.com',
    });
    expect(() => createCustomerRecord('c', 't', {}, NOW)).toThrow(/ao menos/);
  });
});

describe('estorno no domínio', () => {
  const sale = createSale({
    id: 's',
    tenantId: 't',
    source: 'API',
    externalId: 'x',
    customer: {},
    items: [{ productId: 'p', quantity: 1, totalCents: 1 }],
    createdAt: NOW,
  });

  it('pedido de estorno é idempotente e validado', () => {
    const r = requestRefund(sale, { source: 'API' }, NOW);
    expect(r.refund).toMatchObject({ reasonCode: '2', reason: expect.stringMatching(/Estorno/) });
    expect(
      requestRefund(
        r,
        { source: 'MCP', reasonCode: '9', reason: 'outro motivo qualquer aqui' },
        NOW
      )
    ).toBe(r);
    expect(() => requestRefund(sale, { source: 'API', reason: 'curta' }, NOW)).toThrow(/15 a 255/);
  });

  it('encerra antes da emissão, sincroniza nota encontrada e registra falha de cancelamento', () => {
    const aborted = abortBeforeIssue(makeInvoice({ status: 'RETRYING' }), 'estorno', NOW);
    expect(aborted).toMatchObject({ status: 'CANCELLED', cancellation: { beforeIssue: true } });
    expect(() => abortBeforeIssue(makeInvoice({ status: 'ISSUED' }), 'x', NOW)).toThrow();
    const synced = syncIssued(makeInvoice({ status: 'FAILED' }), sampleNfse('8'), NOW);
    expect(synced).toMatchObject({ status: 'ISSUED', nfse: { number: '8' }, deliveries: [] });
    const failed = recordCancellationFailure(synced, [{ code: 'E1', message: 'prazo' }], NOW);
    expect(failed.cancellationErrors).toHaveLength(1);
    expect(
      markCancelled(failed, '2', 'Serviço não prestado ao cliente', NOW).cancellationErrors
    ).toBeUndefined();
  });
});

describe('logo', () => {
  it('valida pela assinatura do arquivo e tamanho', () => {
    expect(validateLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])).contentType).toBe(
      'image/jpeg'
    );
    expect(() => validateLogo(Buffer.alloc(0))).toThrow(/vazia/);
    expect(() => validateLogo(Buffer.alloc(600 * 1024, 0xff))).toThrow(/512 KB/);
    expect(() => validateLogo(Buffer.from('<svg/>'))).toThrow(/PNG ou JPEG/);
  });
});
