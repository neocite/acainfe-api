import forge from 'node-forge';
import { DomainError } from '../../../domain/shared/domain-error.js';

export interface PfxContents {
  privateKeyPem: string;
  certificatePem: string;
  /** Certificado em base64 DER, sem cabeçalhos nem quebras — formato do X509Certificate no XMLDSig. */
  certificateBase64: string;
  certificate: forge.pki.Certificate;
  /** Demais certificados do arquivo (cadeia da autoridade certificadora, quando vem junto). */
  chain: forge.pki.Certificate[];
}

/** Abre um PKCS#12 (.pfx/.p12) e extrai a chave privada e o certificado do titular. */
export function openPfx(pfx: Buffer, password: string): PfxContents {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new DomainError(
      'CERTIFICATE_INVALID',
      'Não foi possível abrir o certificado: arquivo inválido ou senha incorreta'
    );
  }
  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ]?.[0] ?? p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  if (!keyBag?.key || !certBags.length) {
    throw new DomainError(
      'CERTIFICATE_INVALID',
      'O arquivo não contém chave privada e certificado (é um A1?)'
    );
  }
  const key = keyBag.key as forge.pki.rsa.PrivateKey;
  // O certificado do titular é aquele cuja chave pública corresponde à chave privada (o resto é cadeia).
  const leaf =
    certBags
      .map((b) => b.cert)
      .find((c): c is forge.pki.Certificate => {
        const pub = c?.publicKey as forge.pki.rsa.PublicKey | undefined;
        return Boolean(pub && pub.n.equals(key.n));
      }) ?? certBags[0].cert!;
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes();
  return {
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certificatePem: forge.pki.certificateToPem(leaf),
    certificateBase64: forge.util.encode64(der),
    certificate: leaf,
    chain: certBags
      .map((b) => b.cert)
      .filter((c): c is forge.pki.Certificate => Boolean(c) && c !== leaf),
  };
}

// OID 2.16.76.1.3.3 (CNPJ do titular, e-CNPJ ICP-Brasil) em DER: 06 05 60 4C 01 03 03
const ICP_CNPJ_OID = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]);

/** Extrai o CNPJ do certificado ICP-Brasil (SAN otherName 2.16.76.1.3.3), com fallback para o CN "RAZAO:CNPJ". */
export function extractCnpj(cert: forge.pki.Certificate): string | undefined {
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const at = der.indexOf(ICP_CNPJ_OID);
  if (at >= 0) {
    const window = der
      .subarray(at + ICP_CNPJ_OID.length, at + ICP_CNPJ_OID.length + 40)
      .toString('latin1');
    const match = window.match(/\d{14}/);
    if (match) return match[0];
  }
  const cn = cert.subject.getField('CN')?.value as string | undefined;
  return cn?.match(/:(\d{14})\b/)?.[1];
}

const tlsCache = new WeakMap<Buffer, { key: string; cert: string }>();

/**
 * Chave e certificado (com a cadeia) em PEM para o TLS mútuo. O OpenSSL 3 do Node recusa .pfx
 * cifrados com algoritmos antigos (RC2/3DES, comuns em A1 da Certisign/RFB: "Unsupported PKCS12
 * PFX data"); o node-forge abre esses arquivos, então o TLS recebe PEM em vez do .pfx cru.
 */
export function tlsClientCredentials(material: { pfx: Buffer; password: string }): {
  key: string;
  cert: string;
} {
  const cached = tlsCache.get(material.pfx);
  if (cached) return cached;
  const contents = openPfx(material.pfx, material.password);
  const credentials = {
    key: contents.privateKeyPem,
    cert: [
      contents.certificatePem,
      ...contents.chain.map((c) => forge.pki.certificateToPem(c)),
    ].join(''),
  };
  tlsCache.set(material.pfx, credentials);
  return credentials;
}
