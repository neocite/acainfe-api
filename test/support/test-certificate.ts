import forge from 'node-forge';

export interface TestCertificateOptions {
  cnpj?: string;
  password?: string;
  notBefore?: Date;
  notAfter?: Date;
  commonName?: string;
}

let cachedKeys: forge.pki.rsa.KeyPair | undefined;

/** Gera um .pfx autoassinado no formato de um e-CNPJ A1 (CN "RAZAO:CNPJ" + SAN otherName 2.16.76.1.3.3). */
export function generateTestPfx(options: TestCertificateOptions = {}): {
  pfx: Buffer;
  password: string;
} {
  const cnpj = options.cnpj ?? '11222333000181';
  const password = options.password ?? 'senha-teste';
  cachedKeys ??= forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = cachedKeys.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e12));
  // Início fixo, anterior ao NOW dos testes unitários (18/10/2026) e ao relógio real dos e2e.
  cert.validity.notBefore =
    options.notBefore ??
    new Date(Math.min(Date.now() - 86_400_000, Date.parse('2026-01-01T00:00:00Z')));
  cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  const subject = [
    { name: 'commonName', value: options.commonName ?? `EMPRESA TESTE LTDA:${cnpj}` },
    { name: 'countryName', value: 'BR' },
    { shortName: 'O', value: 'ICP-Brasil' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  const otherName = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.OID,
      false,
      forge.asn1.oidToDer('2.16.76.1.3.3').getBytes()
    ),
    forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, cnpj),
    ]),
  ]);
  const san = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    otherName,
  ]);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { id: '2.5.29.17', value: forge.asn1.toDer(san).getBytes() },
  ]);
  cert.sign(cachedKeys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(cachedKeys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  return { pfx: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'), password };
}
