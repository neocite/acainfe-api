import { CertificateMetadata } from '../../domain/certificate/certificate.js';
import { Invoice } from '../../domain/invoice/invoice.js';
import { Logo } from '../../domain/tenant/logo.js';
import { Tenant } from '../../domain/tenant/tenant.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

/** Cifra/decifra segredos (AES-256-GCM com envelope). */
export interface SecretCipher {
  encrypt(plain: Buffer): string;
  decrypt(sealed: string): Buffer;
}

export interface CertificateParser {
  /** Abre o .pfx com a senha e extrai metadados. Lança DomainError CERTIFICATE_INVALID. */
  parse(pfx: Buffer, password: string): CertificateMetadata;
}

export interface DanfseRenderer {
  render(invoice: Invoice, tenant: Tenant, options?: { logo?: Logo }): Promise<Buffer>;
}

/** Baixa uma imagem pública (https) com limites de tamanho/tempo e proteção contra SSRF. */
export interface RemoteFileFetcher {
  fetch(url: string, maxBytes: number): Promise<Buffer>;
}

/** Links temporários para a empresa enviar o certificado sem que ele passe pela conversa com a IA. */
export interface UploadLinks {
  certificateUploadUrl(
    tenantId: string,
    ttlMs: number
  ): { url: string; expiresAt: Date } | undefined;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface WhatsappDocumentMessage {
  /** 55DDDNUMERO */
  phone: string;
  caption: string;
  fileName: string;
  file: Buffer;
  /** URL pública (assinada) do PDF — preferida pelo provedor quando disponível. */
  fileUrl?: string;
}

export interface WhatsappSender {
  sendDocument(message: WhatsappDocumentMessage): Promise<void>;
  sendText(phone: string, text: string): Promise<void>;
}

/** Dados públicos do CNPJ (Receita Federal) — ex.: BrasilAPI. */
export interface CompanyInfo {
  cnpj: string;
  legalName: string;
  tradeName?: string;
  cityCode: string;
  cityName: string;
  uf: string;
  simplesNacional: boolean;
  mei: boolean;
  active: boolean;
  situation: string;
  cnaes: { code: string; description: string; primary: boolean }[];
  address?: {
    street: string;
    number: string;
    complement?: string;
    district: string;
    zipCode: string;
  };
  email?: string;
}

/**
 * Confiança no certificado: só e-CNPJ emitido pela ICP-Brasil prova que quem envia representa a
 * empresa. Lança CERTIFICATE_INVALID se não houver cadeia válida até uma raiz confiável.
 */
export interface CertificateTrust {
  assertTrusted(pfx: Buffer, password: string, cnpj: string): Promise<void>;
}

export interface CompanyRegistry {
  /** null quando o CNPJ não existe; lança em indisponibilidade. */
  lookup(cnpj: string): Promise<CompanyInfo | null>;
}

export interface GatewayProduct {
  id: string;
  externalId?: string;
  name: string;
  description?: string;
  priceCents?: number;
  recurring: boolean;
}

/** Operações administrativas no gateway com a key do próprio usuário. */
/** Cobrança paga (ou estornada) no gateway, para emitir notas de vendas passadas. */
export interface GatewayPaidCharge {
  id: string;
  kind: 'CHECKOUT' | 'TRANSPARENT' | 'SUBSCRIPTION';
  status: 'PAID' | 'REFUNDED';
  paidAt: Date;
  amountCents: number;
  items: { productExternalId: string; quantity: number }[];
  customerId?: string;
}

export interface GatewayCustomer {
  id: string;
  name?: string;
  email?: string;
  taxId?: string;
  phone?: string;
}

export interface PaymentGatewayAdmin {
  /** Também serve para validar a key (lança DomainError UNAUTHORIZED se inválida). */
  listProducts(apiKey: string): Promise<GatewayProduct[]>;
  createWebhook(
    apiKey: string,
    webhook: { name: string; endpoint: string; secret: string; events: string[] }
  ): Promise<{ id: string }>;
  /** Cobranças pagas/estornadas criadas no intervalo (exige CHECKOUT:READ, TRANSPARENT:READ, SUBSCRIPTION:READ). */
  listCharges(apiKey: string, range: { from: Date; to: Date }): Promise<GatewayPaidCharge[]>;
  /** Clientes da conta (exige CUSTOMER:READ). Sem permissão, devolve [] (notas saem sem tomador identificado). */
  listCustomers(apiKey: string): Promise<GatewayCustomer[]>;
}

/** Links públicos assinados para o tomador baixar a nota sem autenticação. */
export interface DocumentLinks {
  pdfUrl(invoiceId: string): string | undefined;
  /** Link assinado (válido por ~60 dias) para baixar o pacote mensal do contador. */
  accountantPackageUrl(tenantId: string, period: string): string | undefined;
  /** Link assinado para a pessoa parar de receber os lembretes da régua de ativação. */
  unsubscribeUrl?(userId: string): string | undefined;
}

/** Compacta arquivos em ZIP. */
export interface ArchiveBuilder {
  zip(files: { name: string; content: Buffer }[]): Buffer;
}

export interface JobScheduler {
  scheduleIssue(invoiceId: string, at?: Date): Promise<void>;
  scheduleDelivery(invoiceId: string, channel: 'EMAIL' | 'WHATSAPP', at?: Date): Promise<void>;
  /** Gera a cobrança (R$ por nota) de uma NFS-e emitida. */
  scheduleCharge(invoiceId: string, at?: Date): Promise<void>;
  /** Liquida o estorno de uma nota (cancelar na prefeitura ou encerrar antes de emitir). */
  scheduleRefund(invoiceId: string, at?: Date): Promise<void>;
}

export interface ServiceCode {
  nationalServiceCode: string;
  lc116Item: string;
  description: string;
  /** NBS admitidos pela tabela oficial de correlação (Anexo VIII). */
  nbsOptions?: string[];
  /** cIndOp (indicador da operação, IBS/CBS) admitidos para o subitem. */
  operationIndicators?: string[];
}

export interface ServiceCodeCatalog {
  search(query: string, limit: number): ServiceCode[];
  find(nationalServiceCode: string): ServiceCode | undefined;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** Gateway para o açaínfe cobrar seus clientes (Pix na conta AbacatePay do açaínfe). */
export interface BillingPaymentGateway {
  createPix(input: {
    amountCents: number;
    description: string;
    expiresInSeconds: number;
    /** Pagador. A AbacatePay exige celular quando o pagador é informado. */
    customer?: { name: string; email: string; taxId: string; cellphone: string };
    metadata: Record<string, string>;
  }): Promise<{ providerId: string; copyPaste: string; qrCodeImage?: string; expiresAt?: Date }>;
}
