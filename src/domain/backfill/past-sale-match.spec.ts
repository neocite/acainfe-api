import { describe, expect, it } from 'vitest';
import {
  markAlreadyIssued,
  matchPastSalesWithMunicipal,
  MunicipalNote,
  PastSale,
} from './past-sale.js';

const sale = (id: string, o: Partial<PastSale> = {}): PastSale => ({
  id,
  tenantId: 't',
  source: 'ABACATEPAY',
  kind: 'CHECKOUT',
  externalId: `bill_${id}`,
  paidAt: new Date('2026-10-10T15:00:00Z'),
  period: '2026-10',
  amountCents: 9700,
  items: [],
  customer: {},
  status: 'AVAILABLE',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});
const note = (number: string, o: Partial<MunicipalNote> = {}): MunicipalNote => ({
  number,
  issuedAt: new Date('2026-10-10T18:00:00Z'),
  amountCents: 9700,
  rps: { number: number, series: '1' },
  ...o,
});

describe('Cruzamento de vendas passadas com notas da prefeitura', () => {
  it('três níveis de confiança', () => {
    const { matches } = matchPastSalesWithMunicipal(
      [
        sale('cpf', { customer: { taxId: '529.982.247-25', name: 'Outro Nome' } }),
        sale('nome', { customer: { name: 'José da Silva' } }),
        sale('valor', { customer: { name: 'Fulano' } }),
      ],
      [
        // Mesmo CPF vale mesmo fora da janela de datas.
        note('1', { customerDocument: '52998224725', issuedAt: new Date('2026-11-20T12:00:00Z') }),
        note('2', { customerName: 'JOSE DA SILVA' }),
        note('3', { customerName: 'Beltrano' }),
      ]
    );
    expect(matches.map((m) => [m.pastSale.id, m.note.number, m.confidence])).toEqual(
      expect.arrayContaining([
        ['cpf', '1', 'HIGH'],
        ['nome', '2', 'MEDIUM'],
        ['valor', '3', 'LOW'],
      ])
    );
  });

  it('cada nota casa com uma venda só; prioriza confiança e proximidade', () => {
    const r = matchPastSalesWithMunicipal(
      [
        sale('a', { customer: { name: 'Ana' } }),
        sale('b', { paidAt: new Date('2026-10-11T15:00:00Z') }),
      ],
      [note('9', { customerName: 'Ana', issuedAt: new Date('2026-10-11T16:00:00Z') })]
    );
    // A venda "b" está mais perto no tempo, mas "a" bate pelo nome (MEDIUM > LOW).
    expect(r.matches.map((m) => [m.pastSale.id, m.confidence])).toEqual([['a', 'MEDIUM']]);
    expect(r.unmatched.map((s) => s.id)).toEqual(['b']);
  });

  it('ignora valor diferente, fora da janela, CPF diferente, cancelada e as do próprio açaínfe', () => {
    const r = matchPastSalesWithMunicipal(
      [sale('x', { customer: { taxId: '52998224725', name: 'Ana' } })],
      [
        note('1', { amountCents: 9701 }),
        note('2', { issuedAt: new Date('2026-11-05T00:00:00Z') }),
        note('3', { customerDocument: '11144477735', customerName: 'Ana' }),
        note('4', { cancelled: true, customerDocument: '52998224725' }),
        note('5', { customerDocument: '52998224725', issuedByAcainfe: true }),
      ]
    );
    expect(r.matches).toEqual([]);
    expect(r.unusedNotes.map((n) => n.number)).toEqual(['1', '2', '3']);
  });

  it('só vendas disponíveis entram; nota um dia antes do pagamento ainda vale', () => {
    const r = matchPastSalesWithMunicipal(
      [sale('ja', { status: 'ALREADY_ISSUED' }), sale('ok')],
      [note('1', { issuedAt: new Date('2026-10-09T16:00:00Z') })]
    );
    expect(r.matches.map((m) => m.pastSale.id)).toEqual(['ok']);
  });

  it('marcar guarda a nota encontrada; desmarcar limpa', () => {
    const ref = { number: '48600', issuedAt: new Date(), confidence: 'HIGH' as const };
    const marked = markAlreadyIssued(sale('s'), true, new Date(), ref);
    expect(marked).toMatchObject({ status: 'ALREADY_ISSUED', matchedNfse: ref });
    expect(markAlreadyIssued(marked, true, new Date()).matchedNfse).toEqual(ref);
    expect(markAlreadyIssued(marked, false, new Date()).matchedNfse).toBeUndefined();
  });
});
