import { DomainError } from '../shared/domain-error.js';
import { Cents } from '../shared/money.js';
import { TaxProfile } from '../product/tax-profile.js';
import { Customer } from '../sale/customer.js';
import { MAX_ATTEMPTS, nextRetryDelayMs } from './retry-policy.js';
import type { FiscalSystem } from '../tenant/tenant.js';

export type InvoiceStatus =
  'PENDING' | 'PROCESSING' | 'RETRYING' | 'ISSUED' | 'REJECTED' | 'FAILED' | 'CANCELLED';

export type DeliveryChannel = 'EMAIL' | 'WHATSAPP';

export interface Delivery {
  channel: DeliveryChannel;
  to: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError?: string;
  sentAt?: Date;
}

export interface InvoiceItem {
  productId: string;
  productName: string;
  description: string;
  quantity: number;
  totalCents: Cents;
}

export interface FiscalError {
  code: string;
  message: string;
  complement?: string;
}

export interface IssuedNfse {
  /** Sistema que emitiu: Sefin nacional (padrão) ou o da prefeitura (Ginfes). */
  provider?: FiscalSystem;
  /** Nacional: chave de acesso (50 dígitos). Ginfes: código de verificação. */
  accessKey: string;
  number: string;
  issuedAt: Date;
  xml: string;
  verificationUrl: string;
  /** Valor do serviço na NFS-e (para conferir que é a nota desta venda). */
  amountCents?: number;
  /** CPF/CNPJ/NIF do tomador na NFS-e ('' = sem tomador identificado; ausente = não foi possível ler). */
  customerDocument?: string;
}

export const DPS_NUMBER_CONFLICT = 'DPS_NUMBER_CONFLICT';
/** Modo piloto: a nota aguarda o usuário conferir a prévia e liberar o envio. */
export const AWAITING_APPROVAL = 'AWAITING_APPROVAL';
/** Emissor Nacional ainda não liberado pela prefeitura após a virada (E0039): nova tentativa em 1h. */
export const AWAITING_MUNICIPALITY = 'AWAITING_MUNICIPALITY';

/**
 * A nota encontrada pelo id do DPS é mesmo desta venda? Se o número do DPS já foi usado por outro
 * sistema (ex.: eNotas), a prefeitura devolve a nota alheia — nunca a adotamos.
 */
export function nfseMatchesInvoice(nfse: IssuedNfse, invoice: Invoice): boolean {
  if (nfse.amountCents !== undefined && nfse.amountCents !== invoice.amountCents) return false;
  // customerDocument: undefined = XML sem o DPS ecoado (não dá para conferir); '' = nota sem tomador identificado.
  if (nfse.customerDocument !== undefined) {
    const ours = invoice.customer.taxId?.value ?? invoice.customer.foreign?.nif ?? '';
    if (nfse.customerDocument !== ours) return false;
  }
  return true;
}

/** Nova numeração para uma nota cujo DPS colidiu com outro sistema. */
export function renumber(invoice: Invoice, dps: Invoice['dps'], now: Date): Invoice {
  return {
    ...invoice,
    dps,
    sentToProvider: false,
    history: withHistory(
      invoice,
      now,
      'RENUMBERED',
      `Nova numeração: série ${dps.series}, nº ${dps.number}`
    ),
    updatedAt: now,
  };
}

export interface InvoiceHistoryEntry {
  at: Date;
  event: string;
  message?: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  saleId: string;
  customer: Customer;
  items: InvoiceItem[];
  taxProfile: TaxProfile;
  /** Discriminação do serviço enviada no DPS (xDescServ). */
  serviceDescription: string;
  amountCents: Cents;
  competenceDate: Date;
  dps: { series: string; number: number; id: string };
  /** HOMOLOGATION = nota sem valor fiscal: não é cobrada nem enviada ao contador. */
  environment?: 'PRODUCTION' | 'HOMOLOGATION';
  status: InvoiceStatus;
  attempts: number;
  /** Já houve envio à prefeitura: antes de reenviar é preciso consultar o DPS (evita nota duplicada). */
  sentToProvider?: boolean;
  /** Sistema que recebeu o envio (consultar/reprocessar no mesmo, mesmo após a virada). */
  fiscalSystem?: FiscalSystem;
  nextAttemptAt?: Date;
  lastErrors?: FiscalError[];
  nfse?: IssuedNfse;
  /** `beforeIssue`: a venda foi estornada antes de a nota existir na prefeitura (nada a cancelar na Sefin). */
  cancellation?: { reasonCode: string; reason: string; at: Date; beforeIssue?: boolean };
  /** Modo piloto: o usuário conferiu a prévia e liberou o envio à prefeitura. */
  approval?: { at: Date; via: 'MCP' | 'API' | 'APP' };
  /** Cobrança (R$ por nota) já registrada para esta nota. */
  billedChargeId?: string;
  /** Último erro ao tentar cancelar na prefeitura (ex.: prazo expirado) — exige ação manual. */
  cancellationErrors?: FiscalError[];
  deliveries: Delivery[];
  history: InvoiceHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const MAX_HISTORY = 100;

const withHistory = (
  invoice: Invoice,
  now: Date,
  event: string,
  message?: string
): InvoiceHistoryEntry[] => [...invoice.history, { at: now, event, message }].slice(-MAX_HISTORY);

function assertStatus(invoice: Invoice, allowed: InvoiceStatus[], action: string): void {
  if (!allowed.includes(invoice.status)) {
    throw DomainError.invalidState(
      `Não é possível ${action} uma nota com status ${invoice.status}`,
      {
        invoiceId: invoice.id,
        status: invoice.status,
      }
    );
  }
}

/**
 * Id do DPS no leiaute nacional:
 * "DPS" + cLocEmi(7) + tpInsc(1: 1=CPF, 2=CNPJ) + inscrição federal(14) + série(5) + nDPS(15).
 */
export function buildDpsId(cityCode: string, cnpj: string, series: string, number: number): string {
  return `DPS${cityCode}2${cnpj.padStart(14, '0')}${series.padStart(5, '0')}${String(number).padStart(15, '0')}`;
}

export function startProcessing(invoice: Invoice, now: Date): Invoice {
  assertStatus(invoice, ['PENDING', 'RETRYING'], 'processar');
  return {
    ...invoice,
    status: 'PROCESSING',
    attempts: invoice.attempts + 1,
    sentToProvider: true,
    nextAttemptAt: undefined,
    history: withHistory(invoice, now, 'PROCESSING', `Tentativa ${invoice.attempts + 1}`),
    updatedAt: now,
  };
}

export function markIssued(
  invoice: Invoice,
  nfse: IssuedNfse,
  channels: { email: boolean; whatsapp: boolean },
  now: Date
): Invoice {
  assertStatus(invoice, ['PROCESSING'], 'marcar como emitida');
  const deliveries: Delivery[] = [];
  if (channels.email && invoice.customer.email) {
    deliveries.push({
      channel: 'EMAIL',
      to: invoice.customer.email,
      status: 'PENDING',
      attempts: 0,
    });
  }
  if (channels.whatsapp && invoice.customer.phone) {
    deliveries.push({
      channel: 'WHATSAPP',
      to: invoice.customer.phone,
      status: 'PENDING',
      attempts: 0,
    });
  }
  return {
    ...invoice,
    status: 'ISSUED',
    nfse,
    lastErrors: undefined,
    deliveries,
    history: withHistory(invoice, now, 'ISSUED', `NFS-e ${nfse.number} chave ${nfse.accessKey}`),
    updatedAt: now,
  };
}

/** Prefeitura/Sefin indisponível: agenda nova tentativa ou desiste (FAILED) após o limite. */
export function markTransientFailure(invoice: Invoice, reason: string, now: Date): Invoice {
  assertStatus(invoice, ['PROCESSING'], 'registrar falha');
  if (invoice.attempts >= MAX_ATTEMPTS) {
    return {
      ...invoice,
      status: 'FAILED',
      lastErrors: [{ code: 'UNAVAILABLE', message: reason }],
      history: withHistory(
        invoice,
        now,
        'FAILED',
        `Limite de ${MAX_ATTEMPTS} tentativas: ${reason}`
      ),
      updatedAt: now,
    };
  }
  const nextAttemptAt = new Date(now.getTime() + nextRetryDelayMs(invoice.attempts));
  return {
    ...invoice,
    status: 'RETRYING',
    nextAttemptAt,
    lastErrors: [{ code: 'UNAVAILABLE', message: reason }],
    history: withHistory(
      invoice,
      now,
      'RETRYING',
      `${reason} — nova tentativa em ${nextAttemptAt.toISOString()}`
    ),
    updatedAt: now,
  };
}

/** Rejeição de regra de negócio pela Sefin: não adianta retentar sem corrigir os dados. */
export function markRejected(invoice: Invoice, errors: FiscalError[], now: Date): Invoice {
  assertStatus(invoice, ['PROCESSING'], 'rejeitar');
  return {
    ...invoice,
    status: 'REJECTED',
    lastErrors: errors,
    history: withHistory(
      invoice,
      now,
      'REJECTED',
      errors.map((e) => `${e.code}: ${e.message}`).join('; ')
    ),
    updatedAt: now,
  };
}

/** Reprocessamento manual (após corrigir produto/cadastro ou quando a prefeitura voltar). */
export function requeue(
  invoice: Invoice,
  now: Date,
  patch?: Partial<Pick<Invoice, 'taxProfile' | 'customer'>>
): Invoice {
  assertStatus(invoice, ['REJECTED', 'FAILED', 'RETRYING'], 'reprocessar');
  return {
    ...invoice,
    ...patch,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: undefined,
    history: withHistory(invoice, now, 'REQUEUED'),
    updatedAt: now,
  };
}

/** Recupera nota travada em PROCESSING (ex.: processo morreu no meio da chamada). */
export function recoverStuck(invoice: Invoice, now: Date): Invoice {
  assertStatus(invoice, ['PROCESSING'], 'recuperar');
  return {
    ...invoice,
    status: 'RETRYING',
    nextAttemptAt: now,
    history: withHistory(
      invoice,
      now,
      'RECOVERED',
      'Processamento interrompido; será reconsultado'
    ),
    updatedAt: now,
  };
}

export function markCancelled(
  invoice: Invoice,
  reasonCode: string,
  reason: string,
  now: Date
): Invoice {
  assertStatus(invoice, ['ISSUED'], 'cancelar');
  return {
    ...invoice,
    status: 'CANCELLED',
    cancellation: { reasonCode, reason, at: now },
    cancellationErrors: undefined,
    history: withHistory(invoice, now, 'CANCELLED', reason),
    updatedAt: now,
  };
}

export function recordDelivery(
  invoice: Invoice,
  channel: DeliveryChannel,
  result: { ok: true } | { ok: false; error: string },
  now: Date
): Invoice {
  const deliveries = invoice.deliveries.map((d) => {
    if (d.channel !== channel) return d;
    return result.ok
      ? {
          ...d,
          status: 'SENT' as const,
          attempts: d.attempts + 1,
          sentAt: now,
          lastError: undefined,
        }
      : { ...d, status: 'FAILED' as const, attempts: d.attempts + 1, lastError: result.error };
  });
  return {
    ...invoice,
    deliveries,
    history: withHistory(
      invoice,
      now,
      result.ok ? `SENT_${channel}` : `SEND_FAILED_${channel}`,
      result.ok ? undefined : result.error
    ),
    updatedAt: now,
  };
}

/** Reenvio: cria/reativa a entrega para o destino informado (ou o do tomador). */
export function prepareDelivery(
  invoice: Invoice,
  channel: DeliveryChannel,
  to: string,
  now: Date
): Invoice {
  assertStatus(invoice, ['ISSUED', 'CANCELLED'], 'enviar');
  const others = invoice.deliveries.filter((d) => d.channel !== channel);
  const previous = invoice.deliveries.find((d) => d.channel === channel);
  return {
    ...invoice,
    deliveries: [...others, { channel, to, status: 'PENDING', attempts: previous?.attempts ?? 0 }],
    updatedAt: now,
  };
}

const ABORTABLE: InvoiceStatus[] = ['PENDING', 'RETRYING', 'REJECTED', 'FAILED'];

/** Estorno antes da emissão: a nota nunca chegou a existir na prefeitura, apenas encerra localmente. */
export function abortBeforeIssue(invoice: Invoice, reason: string, now: Date): Invoice {
  assertStatus(invoice, ABORTABLE, 'abortar');
  return {
    ...invoice,
    status: 'CANCELLED',
    nextAttemptAt: undefined,
    cancellation: { reasonCode: 'NOT_ISSUED', reason, at: now, beforeIssue: true },
    history: withHistory(invoice, now, 'CANCELLED_BEFORE_ISSUE', reason),
    updatedAt: now,
  };
}

/**
 * A prefeitura já tinha a nota (descoberto ao consultar o DPS), embora localmente ela não estivesse ISSUED.
 * Sincroniza sem disparar entregas — usado no fluxo de estorno.
 */
export function syncIssued(invoice: Invoice, nfse: IssuedNfse, now: Date): Invoice {
  assertStatus(invoice, ABORTABLE, 'sincronizar');
  return {
    ...invoice,
    status: 'ISSUED',
    nfse,
    nextAttemptAt: undefined,
    lastErrors: undefined,
    history: withHistory(invoice, now, 'ISSUED', `Encontrada na prefeitura: NFS-e ${nfse.number}`),
    updatedAt: now,
  };
}

export function recordCancellationFailure(
  invoice: Invoice,
  errors: FiscalError[],
  now: Date
): Invoice {
  return {
    ...invoice,
    cancellationErrors: errors,
    history: withHistory(
      invoice,
      now,
      'CANCEL_FAILED',
      errors.map((e) => `${e.code}: ${e.message}`).join('; ')
    ),
    updatedAt: now,
  };
}
