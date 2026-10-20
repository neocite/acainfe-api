import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Clock,
  DocumentLinks,
  IdGenerator,
  Logger,
  UploadLinks,
} from '../../application/ports/services.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export class JsonLogger implements Logger {
  constructor(private readonly silent = false) {}
  private write(level: string, message: string, context?: Record<string, unknown>): void {
    if (this.silent) return;
    process.stdout.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), message, ...context })}\n`
    );
  }
  info(message: string, context?: Record<string, unknown>) {
    this.write('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>) {
    this.write('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>) {
    this.write('error', message, context);
  }
}

/** Links públicos do PDF assinados com HMAC — o tomador baixa sem login, sem expor ids adivinháveis. */
export class HmacDocumentLinks implements DocumentLinks {
  constructor(
    private readonly publicBaseUrl: string | undefined,
    private readonly secret: string
  ) {}

  sign(invoiceId: string): string {
    return createHmac('sha256', this.secret).update(`pdf:${invoiceId}`).digest('base64url');
  }

  verify(invoiceId: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(invoiceId));
    const given = Buffer.from(signature ?? '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private packageSignature(tenantId: string, period: string): string {
    return createHmac('sha256', this.secret)
      .update(`pkg:${tenantId}:${period}`)
      .digest('base64url');
  }

  accountantPackageUrl(tenantId: string, period: string): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    const base = this.publicBaseUrl.replace(/\/$/, '');
    return `${base}/v1/public/accountant-packages/${tenantId}/${period}?sig=${this.packageSignature(tenantId, period)}`;
  }

  verifyAccountantPackage(tenantId: string, period: string, signature: string): boolean {
    const expected = Buffer.from(this.packageSignature(tenantId, period));
    const given = Buffer.from(signature ?? '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  pdfUrl(invoiceId: string): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    return `${this.publicBaseUrl.replace(/\/$/, '')}/v1/public/invoices/${invoiceId}/pdf?sig=${this.sign(invoiceId)}`;
  }
}

/**
 * Token de upload de certificado: `<tenantId>.<expiraEmMs>.<hmac>` — sem estado, expira em minutos.
 * A página de upload envia o .pfx direto para a API, fora da conversa com a IA.
 */
export class HmacUploadLinks implements UploadLinks {
  constructor(
    private readonly publicBaseUrl: string | undefined,
    private readonly secret: string,
    private readonly now: () => number = Date.now
  ) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(`upload:${payload}`).digest('base64url');
  }

  createToken(tenantId: string, ttlMs: number): { token: string; expiresAt: Date } {
    const exp = this.now() + ttlMs;
    const payload = `${tenantId}.${exp}`;
    return { token: `${payload}.${this.sign(payload)}`, expiresAt: new Date(exp) };
  }

  verify(token: string): string | null {
    const parts = (token ?? '').split('.');
    if (parts.length !== 3) return null;
    const [tenantId, exp, sig] = parts;
    const expected = Buffer.from(this.sign(`${tenantId}.${exp}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return Number(exp) > this.now() ? tenantId : null;
  }

  certificateUploadUrl(
    tenantId: string,
    ttlMs: number
  ): { url: string; expiresAt: Date } | undefined {
    if (!this.publicBaseUrl) return undefined;
    const { token, expiresAt } = this.createToken(tenantId, ttlMs);
    return {
      url: `${this.publicBaseUrl.replace(/\/$/, '')}/v1/public/certificate-upload/${token}`,
      expiresAt,
    };
  }
}
