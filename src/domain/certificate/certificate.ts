import { DomainError } from '../shared/domain-error.js';

export interface CertificateMetadata {
  subjectName: string;
  /** CNPJ extraído do certificado ICP-Brasil (OID 2.16.76.1.3.3) ou do CN. */
  cnpj?: string;
  issuer: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
}

export interface Certificate {
  id: string;
  tenantId: string;
  metadata: CertificateMetadata;
  /** .pfx cifrado (envelope AES-256-GCM) — nunca persistido em claro. */
  encryptedPfx: string;
  encryptedPassword: string;
  active: boolean;
  createdAt: Date;
}

export const EXPIRY_WARNING_DAYS = 30;

export function assertCertificateUsable(
  meta: CertificateMetadata,
  tenantCnpj: string,
  now: Date
): void {
  if (meta.notAfter.getTime() <= now.getTime()) {
    throw new DomainError('CERTIFICATE_INVALID', 'Certificado vencido', {
      notAfter: meta.notAfter,
    });
  }
  if (meta.notBefore.getTime() > now.getTime()) {
    throw new DomainError('CERTIFICATE_INVALID', 'Certificado ainda não é válido', {
      notBefore: meta.notBefore,
    });
  }
  // A1 e-CNPJ: a raiz (8 primeiros dígitos) precisa bater com o CNPJ do prestador (permite filial).
  if (meta.cnpj && meta.cnpj.slice(0, 8) !== tenantCnpj.slice(0, 8)) {
    throw new DomainError('CERTIFICATE_INVALID', 'Certificado pertence a outro CNPJ', {
      certificateCnpj: meta.cnpj,
      tenantCnpj,
    });
  }
}

export function daysUntilExpiry(meta: CertificateMetadata, now: Date): number {
  return Math.floor((meta.notAfter.getTime() - now.getTime()) / 86_400_000);
}
