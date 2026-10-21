import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { CertificateTrust } from '../../../application/ports/services.js';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { ICP_BRASIL_ROOTS } from './icp-brasil-roots.js';
import { openPfx } from './pfx.js';

const MAX_DEPTH = 6;
const toX509 = (cert: forge.pki.Certificate): X509Certificate =>
  new X509Certificate(
    Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary')
  );

/** Busca o certificado do emissor pela URL do AIA (caIssuers): .crt (DER/PEM) ou .p7b. */
export type IssuerFetcher = (url: string) => Promise<Buffer>;

const defaultFetcher: IssuerFetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** Certificados de um .crt (DER ou PEM) ou de um pacote PKCS#7 (.p7b/.p7c). */
export function parseIssuerBundle(data: Buffer): X509Certificate[] {
  const text = data.toString('latin1');
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
      (pem) => new X509Certificate(pem)
    );
  }
  try {
    return [new X509Certificate(data)];
  } catch {
    const p7 = forge.pkcs7.messageFromAsn1(
      forge.asn1.fromDer(forge.util.createBuffer(text))
    ) as forge.pkcs7.PkcsSignedData;
    return p7.certificates.map(toX509);
  }
}

/** URLs "CA Issuers" do AIA do certificado. */
const caIssuerUrls = (cert: X509Certificate): string[] =>
  [...(cert.infoAccess ?? '').matchAll(/CA Issuers - URI:(\S+)/g)].map((m) => m[1]);

/**
 * Exige cadeia válida até uma raiz da ICP-Brasil (assinaturas, emissor e validade de cada elo). Os
 * intermediários vêm do próprio .pfx ou, se faltarem, do endereço AIA do certificado.
 * `allowUntrustedCnpjs`: CNPJs de teste (TEST_COMPANY_CNPJS), que podem usar certificado autoassinado.
 */
export class IcpBrasilCertificateTrust implements CertificateTrust {
  private readonly roots: X509Certificate[];

  constructor(
    private readonly options: {
      allowUntrustedCnpjs?: string[];
      fetchIssuer?: IssuerFetcher;
      now?: () => Date;
      roots?: string[];
    } = {}
  ) {
    this.roots = (options.roots ?? Object.values(ICP_BRASIL_ROOTS)).map(
      (pem) => new X509Certificate(pem)
    );
  }

  async assertTrusted(pfx: Buffer, password: string, cnpj: string): Promise<void> {
    if (this.options.allowUntrustedCnpjs?.some((c) => c.replace(/\D/g, '') === cnpj)) return;
    const { certificate, chain } = openPfx(pfx, password);
    const now = (this.options.now ?? (() => new Date()))();
    const pool = chain.map(toX509);
    let current = toX509(certificate);
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (this.roots.some((root) => this.issuedBy(current, root))) return;
      let issuer = pool.find((c) => c.ca && this.issuedBy(current, c));
      if (!issuer) {
        pool.push(...(await this.fetchIssuers(current)));
        issuer = pool.find((c) => c.ca && this.issuedBy(current, c));
      }
      if (!issuer) break;
      if (new Date(issuer.validTo) < now) {
        throw this.untrusted(
          `a autoridade certificadora "${issuer.subject.split('\n').at(-1)}" está vencida`
        );
      }
      current = issuer;
    }
    throw this.untrusted('não encontramos a cadeia até a ICP-Brasil');
  }

  private issuedBy(cert: X509Certificate, issuer: X509Certificate): boolean {
    try {
      return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
    } catch {
      return false;
    }
  }

  private async fetchIssuers(cert: X509Certificate): Promise<X509Certificate[]> {
    const fetchIssuer = this.options.fetchIssuer ?? defaultFetcher;
    const found: X509Certificate[] = [];
    for (const url of caIssuerUrls(cert).slice(0, 3)) {
      try {
        found.push(...parseIssuerBundle(await fetchIssuer(url)));
      } catch {
        // Endereço fora do ar: tenta o próximo; sem nenhum, a cadeia fica incompleta.
      }
    }
    return found;
  }

  private untrusted(reason: string): DomainError {
    return new DomainError(
      'CERTIFICATE_INVALID',
      `Este certificado não é um e-CNPJ válido da ICP-Brasil (${reason}). Envie o certificado A1 emitido por uma autoridade certificadora credenciada.`
    );
  }
}

/** Para testes: aceita qualquer certificado (ex.: autoassinado gerado nos testes). */
export const TRUST_ANY: CertificateTrust = { assertTrusted: async () => undefined };
