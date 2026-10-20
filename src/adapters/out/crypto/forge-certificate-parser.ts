import { CertificateParser } from '../../../application/ports/services.js';
import { CertificateMetadata } from '../../../domain/certificate/certificate.js';
import { extractCnpj, openPfx } from './pfx.js';

const dn = (attrs: { shortName?: string; value?: unknown }[]): string =>
  attrs.map((a) => `${a.shortName ?? '?'}=${String(a.value)}`).join(', ');

export class ForgeCertificateParser implements CertificateParser {
  parse(pfx: Buffer, password: string): CertificateMetadata {
    const { certificate } = openPfx(pfx, password);
    return {
      subjectName: dn(certificate.subject.attributes),
      cnpj: extractCnpj(certificate),
      issuer: dn(certificate.issuer.attributes),
      serialNumber: certificate.serialNumber,
      notBefore: certificate.validity.notBefore,
      notAfter: certificate.validity.notAfter,
    };
  }
}
