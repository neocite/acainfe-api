import { describe, expect, it } from 'vitest';
import { makeInvoice, NOW } from '../../../test/support/fixtures.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import { createProduct } from '../product/product.js';
import { createSale } from '../sale/sale.js';
import { createCustomer } from '../sale/customer.js';
import {
  markCancelled,
  markIssued,
  markRejected,
  markTransientFailure,
  prepareDelivery,
  recordDelivery,
  recoverStuck,
  requeue,
  startProcessing,
} from './invoice.js';
import { splitSaleIntoInvoices } from './invoice-splitter.js';
import { MAX_ATTEMPTS, nextRetryDelayMs, shouldGiveUp } from './retry-policy.js';

const channels = { email: true, whatsapp: true };

describe('ciclo de vida da nota', () => {
  it('PENDING → PROCESSING → ISSUED cria entregas conforme contatos do tomador', () => {
    const processing = startProcessing(makeInvoice(), NOW);
    expect(processing).toMatchObject({ status: 'PROCESSING', attempts: 1, sentToProvider: true });
    const issued = markIssued(processing, sampleNfse('42'), channels, NOW);
    expect(issued.status).toBe('ISSUED');
    expect(issued.deliveries.map((d) => [d.channel, d.to])).toEqual([
      ['EMAIL', 'maria@example.com'],
      ['WHATSAPP', '5511999998888'],
    ]);
  });

  it('respeita canais desligados pela empresa e tomador sem contato', () => {
    const p = startProcessing(makeInvoice({ customer: { email: 'a@b.com' } }), NOW);
    expect(markIssued(p, sampleNfse(), { email: false, whatsapp: true }, NOW).deliveries).toEqual(
      []
    );
    expect(markIssued(p, sampleNfse(), channels, NOW).deliveries).toHaveLength(1);
  });

  it('falha transitória agenda retentativa com backoff e desiste no limite', () => {
    const retrying = markTransientFailure(startProcessing(makeInvoice(), NOW), 'Sefin 503', NOW);
    expect(retrying.status).toBe('RETRYING');
    expect(retrying.nextAttemptAt!.getTime() - NOW.getTime()).toBe(nextRetryDelayMs(1));

    const exhausted = markTransientFailure(
      { ...makeInvoice(), status: 'PROCESSING', attempts: MAX_ATTEMPTS },
      'Sefin 503',
      NOW
    );
    expect(exhausted.status).toBe('FAILED');
  });

  it('rejeição guarda os erros e pode ser reprocessada', () => {
    const rejected = markRejected(
      startProcessing(makeInvoice(), NOW),
      [{ code: 'E1', message: 'erro' }],
      NOW
    );
    expect(rejected).toMatchObject({ status: 'REJECTED', lastErrors: [{ code: 'E1' }] });
    const requeued = requeue(rejected, NOW);
    expect(requeued).toMatchObject({ status: 'PENDING', attempts: 0, sentToProvider: true });
  });

  it('impede transições inválidas', () => {
    expect(() => markIssued(makeInvoice(), sampleNfse(), channels, NOW)).toThrow(/PENDING/);
    expect(() => startProcessing(makeInvoice({ status: 'ISSUED' }), NOW)).toThrow(/ISSUED/);
    expect(() => markCancelled(makeInvoice(), '1', 'x', NOW)).toThrow();
    expect(() => requeue(makeInvoice({ status: 'ISSUED' }), NOW)).toThrow();
    expect(() => prepareDelivery(makeInvoice(), 'EMAIL', 'a@b.com', NOW)).toThrow();
  });

  it('recupera notas travadas em PROCESSING', () => {
    const recovered = recoverStuck(startProcessing(makeInvoice(), NOW), NOW);
    expect(recovered).toMatchObject({ status: 'RETRYING', nextAttemptAt: NOW });
  });

  it('cancela nota emitida', () => {
    const issued = markIssued(startProcessing(makeInvoice(), NOW), sampleNfse(), channels, NOW);
    expect(markCancelled(issued, '2', 'Serviço não prestado ao cliente', NOW)).toMatchObject({
      status: 'CANCELLED',
      cancellation: { reasonCode: '2' },
    });
  });

  it('registra resultado de entregas e prepara reenvio', () => {
    const issued = markIssued(startProcessing(makeInvoice(), NOW), sampleNfse(), channels, NOW);
    const failed = recordDelivery(issued, 'EMAIL', { ok: false, error: 'bounce' }, NOW);
    expect(failed.deliveries[0]).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'bounce',
    });
    const sent = recordDelivery(failed, 'EMAIL', { ok: true }, NOW);
    expect(sent.deliveries[0]).toMatchObject({ status: 'SENT', attempts: 2 });
    const again = prepareDelivery(sent, 'EMAIL', 'outro@x.com', NOW);
    expect(again.deliveries.find((d) => d.channel === 'EMAIL')).toMatchObject({
      status: 'PENDING',
      to: 'outro@x.com',
    });
  });

  it('mantém histórico limitado', () => {
    let inv = makeInvoice({
      history: Array.from({ length: 100 }, (_, i) => ({ at: NOW, event: `E${i}` })),
    });
    inv = startProcessing(inv, NOW);
    expect(inv.history).toHaveLength(100);
    expect(inv.history.at(-1)!.event).toBe('PROCESSING');
  });
});

describe('política de retentativa', () => {
  it('cresce até o teto de 12h', () => {
    expect(nextRetryDelayMs(1)).toBe(30_000);
    expect(nextRetryDelayMs(2)).toBeGreaterThan(nextRetryDelayMs(1));
    expect(nextRetryDelayMs(50)).toBe(12 * 3_600_000);
    expect(shouldGiveUp(MAX_ATTEMPTS)).toBe(true);
    expect(shouldGiveUp(1)).toBe(false);
  });
});

describe('divisão da venda em notas (diferencial)', () => {
  const ti = createProduct(
    'ti',
    't1',
    { name: 'Suporte TI', taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' } },
    NOW
  );
  const curso = createProduct(
    'curso',
    't1',
    { name: 'Curso', taxProfile: { nationalServiceCode: '080201', nbsCode: '122051900' } },
    NOW
  );
  const ti2 = createProduct(
    'ti2',
    't1',
    { name: 'Manutenção', taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' } },
    NOW
  );
  const products = new Map([ti, curso, ti2].map((p) => [p.id, p]));

  const sale = createSale({
    id: 's1',
    tenantId: 't1',
    source: 'API',
    externalId: 'pedido-1',
    customer: createCustomer({}),
    items: [
      { productId: 'ti', quantity: 1, totalCents: 10000 },
      { productId: 'curso', quantity: 2, totalCents: 50000 },
      { productId: 'ti2', quantity: 1, totalCents: 5000 },
    ],
    createdAt: NOW,
  });

  it('gera uma nota por perfil tributário', () => {
    const drafts = splitSaleIntoInvoices(sale, products);
    expect(drafts).toHaveLength(2);
    const tiDraft = drafts.find((d) => d.taxProfile.nationalServiceCode === '010701')!;
    expect(tiDraft.amountCents).toBe(15000);
    expect(tiDraft.items.map((i) => i.productId)).toEqual(['ti', 'ti2']);
    expect(tiDraft.serviceDescription).toContain('1x Suporte TI');
    const cursoDraft = drafts.find((d) => d.taxProfile.nationalServiceCode === '080201')!;
    expect(cursoDraft.amountCents).toBe(50000);
  });

  it('item único usa a discriminação do produto sem prefixo', () => {
    const one = createSale({
      ...sale,
      items: [{ productId: 'ti', quantity: 1, totalCents: 100, description: 'Chamado #123' }],
    });
    expect(splitSaleIntoInvoices(one, products)[0].serviceDescription).toBe('Chamado #123');
  });

  it('falha com produto desconhecido ou inativo', () => {
    expect(() => splitSaleIntoInvoices(sale, new Map([[ti.id, ti]]))).toThrow(/não encontrado/);
    const inactive = new Map(products);
    inactive.set('curso', { ...curso, active: false });
    expect(() => splitSaleIntoInvoices(sale, inactive)).toThrow(/inativo/);
  });
});

describe('venda', () => {
  const base = {
    id: 's',
    tenantId: 't',
    source: 'API' as const,
    externalId: 'x',
    customer: {},
    createdAt: NOW,
  };
  it('valida itens e total', () => {
    expect(() => createSale({ ...base, items: [] })).toThrow(/ao menos um item/);
    expect(() =>
      createSale({ ...base, items: [{ productId: 'p', quantity: 0, totalCents: 1 }] })
    ).toThrow(/quantity/);
    expect(() =>
      createSale({ ...base, items: [{ productId: 'p', quantity: 1, totalCents: 0 }] })
    ).toThrow(/maior que zero/);
    expect(() =>
      createSale({
        ...base,
        externalId: ' ',
        items: [{ productId: 'p', quantity: 1, totalCents: 1 }],
      })
    ).toThrow(/externalId/);
  });

  it('tomador: documento exige nome e descarta documento mascarado', () => {
    expect(() => createCustomer({ taxId: '529.982.247-25' })).toThrow(/name/);
    expect(createCustomer({ taxId: '123.***.***-**', email: 'X@Y.com' })).toEqual({
      email: 'x@y.com',
    });
  });
});
