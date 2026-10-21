import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { generateTestPfx } from '../../../../test/support/test-certificate.js';
import { ICP_BRASIL_ROOT_FINGERPRINTS, ICP_BRASIL_ROOTS } from './icp-brasil-roots.js';
import { IcpBrasilCertificateTrust, parseIssuerBundle } from './icp-brasil-trust.js';

const CNPJ = '11222333000181';
const keys = () => forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
const day = 86_400_000;

function makeCert(opts: {
  subject: string;
  issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };
  key: forge.pki.rsa.KeyPair;
  ca: boolean;
  notAfter?: Date;
  aia?: string;
}): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = opts.key.publicKey;
  cert.serialNumber = String(Math.floor(Math.random() * 1e9));
  cert.validity.notBefore = new Date(Date.now() - day);
  cert.validity.notAfter = opts.notAfter ?? new Date(Date.now() + 365 * day);
  const attrs = [
    { name: 'commonName', value: opts.subject },
    { name: 'countryName', value: 'BR' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : attrs);
  const extensions: object[] = [
    { name: 'basicConstraints', cA: opts.ca },
    { name: 'keyUsage', keyCertSign: opts.ca, digitalSignature: true },
  ];
  if (opts.aia) {
    // AuthorityInfoAccess: caIssuers (1.3.6.1.5.5.7.48.2) → URI (GeneralName [6]).
    const aia = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.OID,
          false,
          forge.asn1.oidToDer('1.3.6.1.5.5.7.48.2').getBytes()
        ),
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 6, false, opts.aia),
      ]),
    ]);
    extensions.push({ id: '1.3.6.1.5.5.7.1.1', value: forge.asn1.toDer(aia).getBytes() });
  }
  cert.setExtensions(extensions);
  cert.sign(opts.issuer?.key ?? opts.key.privateKey, forge.md.sha256.create());
  return cert;
}

const rootKey = keys();
const root = makeCert({ subject: 'AC Raiz Teste', key: rootKey, ca: true });
const interKey = keys();
const inter = makeCert({
  subject: 'AC Intermediaria Teste',
  key: interKey,
  ca: true,
  issuer: { cert: root, key: rootKey.privateKey },
});
const leafKey = keys();
const leaf = makeCert({
  subject: `EMPRESA LTDA:${CNPJ}`,
  key: leafKey,
  ca: false,
  issuer: { cert: inter, key: interKey.privateKey },
  aia: 'http://ac.teste/intermediaria.p7b',
});

const pfx = (certs: forge.pki.Certificate[], password = 'senha') => ({
  pfx: Buffer.from(
    forge.asn1
      .toDer(forge.pkcs12.toPkcs12Asn1(leafKey.privateKey, certs, password, { algorithm: '3des' }))
      .getBytes(),
    'binary'
  ),
  password,
});
const der = (cert: forge.pki.Certificate) =>
  Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
const trust = (options: ConstructorParameters<typeof IcpBrasilCertificateTrust>[0] = {}) =>
  new IcpBrasilCertificateTrust({ roots: [forge.pki.certificateToPem(root)], ...options });

describe('IcpBrasilCertificateTrust', () => {
  it('aceita a cadeia completa dentro do .pfx', async () => {
    const p = pfx([leaf, inter]);
    await expect(trust().assertTrusted(p.pfx, p.password, CNPJ)).resolves.toBeUndefined();
  });

  it('sem a intermediária no .pfx, busca pelo AIA do certificado (.p7b)', async () => {
    const p = pfx([leaf]);
    const p7 = forge.pkcs7.createSignedData();
    p7.addCertificate(inter);
    const bundle = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
    const fetched: string[] = [];
    const t = trust({
      fetchIssuer: async (url) => {
        fetched.push(url);
        return bundle;
      },
    });
    await expect(t.assertTrusted(p.pfx, p.password, CNPJ)).resolves.toBeUndefined();
    expect(fetched).toEqual(['http://ac.teste/intermediaria.p7b']);
    // AIA fora do ar: cadeia incompleta.
    const offline = trust({ fetchIssuer: async () => Promise.reject(new Error('timeout')) });
    await expect(offline.assertTrusted(p.pfx, p.password, CNPJ)).rejects.toMatchObject({
      code: 'CERTIFICATE_INVALID',
    });
  });

  it('recusa autoassinado (o ataque relatado), exceto CNPJ de teste', async () => {
    const self = generateTestPfx({ cnpj: CNPJ });
    await expect(trust().assertTrusted(self.pfx, self.password, CNPJ)).rejects.toThrow(
      /não é um e-CNPJ válido da ICP-Brasil/
    );
    await expect(
      trust({ allowUntrustedCnpjs: ['11.222.333/0001-81'] }).assertTrusted(
        self.pfx,
        self.password,
        CNPJ
      )
    ).resolves.toBeUndefined();
    // As raízes reais também não confiam no autoassinado.
    await expect(
      new IcpBrasilCertificateTrust({ fetchIssuer: async () => Buffer.alloc(0) }).assertTrusted(
        self.pfx,
        self.password,
        CNPJ
      )
    ).rejects.toMatchObject({ code: 'CERTIFICATE_INVALID' });
  });

  it('recusa cadeia com autoridade intermediária vencida', async () => {
    const expiredInter = makeCert({
      subject: 'AC Intermediaria Teste',
      key: interKey,
      ca: true,
      issuer: { cert: root, key: rootKey.privateKey },
      notAfter: new Date(Date.now() + day),
    });
    const p = pfx([leaf, expiredInter]);
    const later = trust({ now: () => new Date(Date.now() + 10 * day) });
    await expect(later.assertTrusted(p.pfx, p.password, CNPJ)).rejects.toThrow(/vencida/);
  });

  it('raízes embutidas são as da ICP-Brasil (SHA-256 conferido) e leitura de .crt DER', () => {
    for (const [name, pem] of Object.entries(ICP_BRASIL_ROOTS)) {
      const cert = new X509Certificate(pem);
      expect(cert.fingerprint256).toBe(ICP_BRASIL_ROOT_FINGERPRINTS[name]);
      expect(cert.subject).toMatch(/Autoridade Certificadora Raiz Brasileira/);
    }
    expect(parseIssuerBundle(der(inter))[0].subject).toMatch(/AC Intermediaria Teste/);
  });
});
