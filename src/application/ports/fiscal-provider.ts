import { Invoice, IssuedNfse, FiscalError } from '../../domain/invoice/invoice.js';
import { Tenant } from '../../domain/tenant/tenant.js';

/** Certificado A1 descriptografado — só existe em memória durante a operação. */
export interface CertificateMaterial {
  pfx: Buffer;
  password: string;
}

export type IssueOutcome =
  | { kind: 'ISSUED'; nfse: IssuedNfse }
  | { kind: 'REJECTED'; errors: FiscalError[] }
  /** DPS já recebido anteriormente (ex.: timeout após envio). O caller deve reconsultar. */
  | { kind: 'DUPLICATE'; errors: FiscalError[] };

/** Erro de infraestrutura (prefeitura/Sefin fora do ar, timeout, 5xx). Sempre retentável. */
export class FiscalProviderUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'FiscalProviderUnavailableError';
  }
}

export interface FiscalProvider {
  readonly name: string;
  /**
   * Modo piloto (integração nova): cada nota só vai à prefeitura depois que o usuário conferir a
   * prévia e aprovar.
   */
  readonly requiresApproval?: boolean;
  /** XML que seria enviado (sem assinatura), para conferência antes de aprovar. */
  preview?(invoice: Invoice, tenant: Tenant): string;
  /** Uma nota da prefeitura pelo número, com o XML como gravado — consulta sem efeito colateral. */
  getIssued?(
    tenant: Tenant,
    certificate: CertificateMaterial,
    number: string,
    /** Dia da emissão: permite consultar pelo período (mais rápido em alguns municípios). */
    issuedOn?: Date
  ): Promise<(MunicipalNfseSummary & { xml: string }) | null>;
  /** Notas já emitidas no período (inclusive por outros sistemas) — consulta sem efeito colateral. */
  listIssued?(
    tenant: Tenant,
    certificate: CertificateMaterial,
    range: { from: Date; to: Date }
  ): Promise<MunicipalNfseSummary[]>;
  issue(invoice: Invoice, tenant: Tenant, certificate: CertificateMaterial): Promise<IssueOutcome>;
  /** Consulta pelo id do DPS — usado para idempotência após timeouts. */
  findByDpsId(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssuedNfse | null>;
  cancel(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial,
    reason: { code: string; description: string }
  ): Promise<{ ok: true } | { ok: false; errors: FiscalError[] }>;
}

export interface MunicipalNfseSummary {
  number: string;
  verificationCode?: string;
  issuedAt: Date;
  rps?: { number: string; series: string };
  amountCents: number;
  issRateBps?: number;
  serviceItem?: string;
  municipalTaxCode?: string;
  customerDocument?: string;
  customerName?: string;
  description?: string;
  cancelled?: boolean;
  /** Campos fiscais como gravados pela prefeitura (para conferência campo a campo). */
  details?: Record<string, string | undefined>;
  /** Marcado pelo açaínfe ao consultar: a nota é de uma venda emitida por aqui. */
  issuedByAcainfe?: boolean;
}

/** Resolve o provedor fiscal do município/regime do tenant (Nacional no MVP; Ginfes depois). */
export interface FiscalProviderResolver {
  /** Sistema da empresa numa data (padrão: agora) — ex.: consultas à prefeitura. */
  resolve(tenant: Tenant, at?: Date): FiscalProvider;
  /**
   * Sistema de UMA nota: o que a emitiu (cancelar, consultar, reprocessar), o que já recebeu o envio
   * (consulta após timeout) ou, para nota nova, o da competência (virada para o Emissor Nacional).
   */
  forInvoice?(invoice: Invoice, tenant: Tenant): FiscalProvider;
}

export interface MunicipalServiceParams {
  cityCode: string;
  nationalServiceCode: string;
  issRateBps?: number;
  allowsRetention?: boolean;
  raw: unknown;
}

export interface MunicipalParamsGateway {
  /** A ADN exige mTLS: a consulta usa o certificado do próprio tenant. */
  get(
    cityCode: string,
    nationalServiceCode: string,
    competence: Date,
    context: { tenant: Tenant; certificate: CertificateMaterial }
  ): Promise<MunicipalServiceParams | null>;
}
