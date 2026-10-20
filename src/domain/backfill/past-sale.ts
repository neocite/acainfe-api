import { DomainError } from '../shared/domain-error.js';
import { Cents } from '../shared/money.js';

/**
 * Venda paga no gateway ANTES de a empresa usar o açaínfe (ou sem nota). Fica como candidata:
 * o usuário revisa, marca o que já tem nota em outro sistema e decide emitir.
 */
export interface PastSale {
  id: string;
  tenantId: string;
  source: 'ABACATEPAY';
  kind: 'CHECKOUT' | 'TRANSPARENT' | 'SUBSCRIPTION';
  /** Id da cobrança no gateway — mesmo externalId que o webhook usaria (sem duplicar). */
  externalId: string;
  paidAt: Date;
  /** Mês de competência AAAA-MM (Brasília). */
  period: string;
  amountCents: Cents;
  items: { productExternalId: string; quantity: number }[];
  customer: { externalId?: string; name?: string; email?: string; taxId?: string; phone?: string };
  /**
   * AVAILABLE = pode emitir; ALREADY_ISSUED = usuário marcou que já tem nota em outro sistema;
   * IMPORTED = virou venda no açaínfe; REFUNDED = estornada/contestada (nunca emitir).
   */
  status: 'AVAILABLE' | 'ALREADY_ISSUED' | 'IMPORTED' | 'REFUNDED';
  /** Ambiente da venda criada na importação: ao trocar de ambiente, a venda volta a ficar disponível. */
  importedEnvironment?: 'PRODUCTION' | 'HOMOLOGATION';
  saleId?: string;
  /** Nota encontrada na prefeitura (emitida por outro sistema) que corresponde a esta venda. */
  matchedNfse?: { number: string; issuedAt: Date; confidence: MatchConfidence };
  /** Quando o mês desta venda foi cruzado com as notas da prefeitura. */
  reconciledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PastSalesPeriodSummary {
  period: string;
  isCurrentMonth: boolean;
  /** Meses anteriores: a receita deveria ter entrado no DAS daquele mês — exige ciência do usuário. */
  requiresConfirmation: boolean;
  available: { count: number; totalCents: Cents; withoutItems: number };
  alreadyIssued: number;
  imported: number;
  refunded: number;
}

export const PAST_PERIOD_WARNING =
  'Vendas de meses anteriores: a nota sai com a competência do mês da venda. No Simples Nacional essa receita ' +
  'deveria ter sido declarada no DAS daquele mês; se não foi, seu contador precisa retificar o PGDAS (pode haver ' +
  'multa e juros). Confirme com seu contador antes de emitir.';

export function summarizePastSales(
  sales: PastSale[],
  currentPeriod: string
): PastSalesPeriodSummary[] {
  const byPeriod = new Map<string, PastSalesPeriodSummary>();
  for (const s of sales) {
    const g =
      byPeriod.get(s.period) ??
      ({
        period: s.period,
        isCurrentMonth: s.period === currentPeriod,
        requiresConfirmation: s.period !== currentPeriod,
        available: { count: 0, totalCents: 0, withoutItems: 0 },
        alreadyIssued: 0,
        imported: 0,
        refunded: 0,
      } satisfies PastSalesPeriodSummary);
    if (s.status === 'AVAILABLE') {
      g.available.count++;
      g.available.totalCents += s.amountCents;
      if (!s.items.length) g.available.withoutItems++;
    } else if (s.status === 'ALREADY_ISSUED') g.alreadyIssued++;
    else if (s.status === 'IMPORTED') g.imported++;
    else g.refunded++;
    byPeriod.set(s.period, g);
  }
  return [...byPeriod.values()].sort((a, b) => b.period.localeCompare(a.period));
}

/** Marcar/desmarcar "já tem nota em outro sistema" só vale para vendas ainda não emitidas. */
export function markAlreadyIssued(
  sale: PastSale,
  alreadyIssued: boolean,
  now: Date,
  matchedNfse?: PastSale['matchedNfse']
): PastSale {
  if (sale.status === 'IMPORTED' || sale.status === 'REFUNDED') {
    throw DomainError.invalidState(
      `A venda ${sale.externalId} já foi ${sale.status === 'IMPORTED' ? 'emitida' : 'estornada'}`
    );
  }
  return {
    ...sale,
    status: alreadyIssued ? 'ALREADY_ISSUED' : 'AVAILABLE',
    // Desmarcar apaga a referência; marcar à mão mantém a que já existia.
    matchedNfse: alreadyIssued ? (matchedNfse ?? sale.matchedNfse) : undefined,
    updatedAt: now,
  };
}

// ---------- Cruzamento com as notas já emitidas na prefeitura ----------

export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
const RANK: Record<MatchConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
export const atLeast = (c: MatchConfidence, min: MatchConfidence): boolean => RANK[c] >= RANK[min];

/** Nota emitida na prefeitura (qualquer sistema), como devolvida pela consulta municipal. */
export interface MunicipalNote {
  number: string;
  issuedAt: Date;
  amountCents: number;
  customerDocument?: string;
  customerName?: string;
  cancelled?: boolean;
  rps?: { number: string; series: string };
  /** Emitida pelo próprio açaínfe (não é "nota de outro sistema"). */
  issuedByAcainfe?: boolean;
}

export interface PastSaleMatch {
  pastSale: PastSale;
  note: MunicipalNote;
  confidence: MatchConfidence;
}

const DAY = 86_400_000;
/** A nota costuma sair no dia do pagamento ou alguns dias depois (emissão em lote, fim de mês). */
export const MATCH_WINDOW = { beforeMs: DAY, afterMs: 15 * DAY };

const normalizeName = (name?: string): string =>
  (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function confidenceOf(sale: PastSale, note: MunicipalNote): MatchConfidence | null {
  if (note.amountCents !== sale.amountCents) return null;
  const doc = sale.customer.taxId?.replace(/\D/g, '');
  if (doc && note.customerDocument && doc === note.customerDocument) return 'HIGH';
  const delta = note.issuedAt.getTime() - sale.paidAt.getTime();
  if (delta < -MATCH_WINDOW.beforeMs || delta > MATCH_WINDOW.afterMs) return null;
  // Documentos diferentes dos dois lados: não é a mesma pessoa.
  if (doc && note.customerDocument && doc !== note.customerDocument) return null;
  const name = normalizeName(sale.customer.name);
  if (name && name === normalizeName(note.customerName)) return 'MEDIUM';
  return 'LOW';
}

/**
 * Casa cada venda disponível com no máximo uma nota (e cada nota com no máximo uma venda),
 * priorizando a confiança mais alta e, em empate, a nota mais próxima do pagamento.
 * Notas canceladas e as emitidas pelo próprio açaínfe ficam de fora.
 */
export function matchPastSalesWithMunicipal(
  sales: PastSale[],
  notes: MunicipalNote[]
): { matches: PastSaleMatch[]; unmatched: PastSale[]; unusedNotes: MunicipalNote[] } {
  const candidates = notes.filter((n) => !n.cancelled && !n.issuedByAcainfe);
  const pairs: { sale: PastSale; note: MunicipalNote; confidence: MatchConfidence; gap: number }[] =
    [];
  for (const sale of sales.filter((s) => s.status === 'AVAILABLE')) {
    for (const note of candidates) {
      const confidence = confidenceOf(sale, note);
      if (confidence) {
        pairs.push({
          sale,
          note,
          confidence,
          gap: Math.abs(note.issuedAt.getTime() - sale.paidAt.getTime()),
        });
      }
    }
  }
  pairs.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || a.gap - b.gap);
  const usedSales = new Set<string>();
  const usedNotes = new Set<string>();
  const matches: PastSaleMatch[] = [];
  for (const p of pairs) {
    if (usedSales.has(p.sale.id) || usedNotes.has(p.note.number)) continue;
    usedSales.add(p.sale.id);
    usedNotes.add(p.note.number);
    matches.push({ pastSale: p.sale, note: p.note, confidence: p.confidence });
  }
  return {
    matches: matches.sort((a, b) => a.pastSale.paidAt.getTime() - b.pastSale.paidAt.getTime()),
    unmatched: sales.filter((s) => s.status === 'AVAILABLE' && !usedSales.has(s.id)),
    unusedNotes: candidates.filter((n) => !usedNotes.has(n.number)),
  };
}

/** Mês corrente AAAA-MM em Brasília. */
export function currentPeriod(now: Date): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);
}
