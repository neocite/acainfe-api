import {
  assertCertificateUsable,
  Certificate,
  CertificateMetadata,
  daysUntilExpiry,
  EXPIRY_WARNING_DAYS,
} from '../../domain/certificate/certificate.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import { CertificateMaterial } from '../ports/fiscal-provider.js';
import { CertificateRepository, TenantRepository } from '../ports/repositories.js';
import {
  CertificateParser,
  Clock,
  EmailSender,
  IdGenerator,
  Logger,
  SecretCipher,
  UploadLinks,
} from '../ports/services.js';

export interface CertificateStatus {
  present: boolean;
  metadata?: CertificateMetadata;
  daysUntilExpiry?: number;
  expiringSoon?: boolean;
  expired?: boolean;
}

const WARN_AT_DAYS = new Set([30, 15, 7, 3, 1]);

export class CertificateService {
  constructor(
    private readonly deps: {
      certificates: CertificateRepository;
      tenants: TenantRepository;
      parser: CertificateParser;
      cipher: SecretCipher;
      clock: Clock;
      ids: IdGenerator;
      email: EmailSender;
      logger: Logger;
      uploadLinks: UploadLinks;
    }
  ) {}

  async upload(tenant: Tenant, pfx: Buffer, password: string): Promise<CertificateStatus> {
    if (!pfx?.length) throw DomainError.validation('Arquivo .pfx vazio');
    const metadata = this.deps.parser.parse(pfx, password);
    const now = this.deps.clock.now();
    assertCertificateUsable(metadata, tenant.cnpj, now);
    const certificate: Certificate = {
      id: this.deps.ids.next(),
      tenantId: tenant.id,
      metadata,
      encryptedPfx: this.deps.cipher.encrypt(pfx),
      encryptedPassword: this.deps.cipher.encrypt(Buffer.from(password, 'utf8')),
      active: true,
      createdAt: now,
    };
    await this.deps.certificates.saveActive(certificate);
    return this.toStatus(certificate, now);
  }

  /**
   * Link temporário (30 min) para enviar o .pfx e a senha por uma página web,
   * sem que o certificado passe pela conversa com o agente de IA.
   */
  createUploadLink(tenantId: string): { url: string; expiresAt: Date } {
    const link = this.deps.uploadLinks.certificateUploadUrl(tenantId, 30 * 60_000);
    if (!link) throw DomainError.validation('PUBLIC_BASE_URL não configurada no servidor');
    return link;
  }

  async status(tenantId: string): Promise<CertificateStatus> {
    const cert = await this.deps.certificates.findActive(tenantId);
    if (!cert) return { present: false };
    return this.toStatus(cert, this.deps.clock.now());
  }

  /** Material descriptografado para assinatura/mTLS. Lança se ausente ou inválido. */
  async loadMaterial(tenant: Tenant): Promise<CertificateMaterial> {
    const cert = await this.deps.certificates.findActive(tenant.id);
    if (!cert) {
      throw new DomainError(
        'CERTIFICATE_MISSING',
        'Nenhum certificado A1 cadastrado para a empresa'
      );
    }
    assertCertificateUsable(cert.metadata, tenant.cnpj, this.deps.clock.now());
    return {
      pfx: this.deps.cipher.decrypt(cert.encryptedPfx),
      password: this.deps.cipher.decrypt(cert.encryptedPassword).toString('utf8'),
    };
  }

  /** Job diário: avisa a empresa por e-mail quando o certificado está para vencer. */
  async warnExpiring(): Promise<number> {
    const now = this.deps.clock.now();
    const limit = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 86_400_000);
    const expiring = await this.deps.certificates.listActiveExpiringBefore(limit);
    let sent = 0;
    for (const cert of expiring) {
      const days = daysUntilExpiry(cert.metadata, now);
      if (!WARN_AT_DAYS.has(days)) continue;
      const tenant = await this.deps.tenants.findById(cert.tenantId);
      if (!tenant) continue;
      try {
        await this.deps.email.send({
          to: tenant.email,
          subject: `Seu certificado digital vence em ${days} dia(s) — açaínfe`,
          text: `O certificado A1 de ${tenant.legalName} vence em ${cert.metadata.notAfter.toLocaleDateString('pt-BR')}. Envie um novo para não interromper a emissão de notas.`,
          html: `<p>O certificado A1 de <b>${tenant.legalName}</b> vence em <b>${cert.metadata.notAfter.toLocaleDateString('pt-BR')}</b>.</p><p>Envie um novo certificado para não interromper a emissão de notas.</p>`,
          attachments: [],
        });
        sent++;
      } catch (error) {
        this.deps.logger.warn('Falha ao avisar vencimento de certificado', {
          tenantId: tenant.id,
          error: String(error),
        });
      }
    }
    return sent;
  }

  private toStatus(cert: Certificate, now: Date): CertificateStatus {
    const days = daysUntilExpiry(cert.metadata, now);
    return {
      present: true,
      metadata: cert.metadata,
      daysUntilExpiry: days,
      expiringSoon: days <= EXPIRY_WARNING_DAYS,
      expired: days < 0,
    };
  }
}
