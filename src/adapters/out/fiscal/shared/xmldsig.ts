import { SignedXml } from 'xml-crypto';
import { PfxContents } from '../../crypto/pfx.js';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/**
 * XMLDSig dos sistemas municipais (Ginfes, NFS-e Paulistana): RSA-SHA1, digest SHA1, C14N inclusivo,
 * KeyInfo só com o certificado.
 * - `reference`: elemento assinado. Com Id (ex.: LoteRps) a referência é `#Id`; sem Id, `URI=""`.
 * - `placement`: `after` = Signature como irmão seguinte; `append` = último filho de `container`.
 */
export function signEnvelopedSha1(
  xml: string,
  pfx: PfxContents,
  options: { reference: string; placement: 'after' | 'append'; container?: string; byId: boolean }
): string {
  const refXpath = `//*[local-name(.)='${options.reference}']`;
  const sig = new SignedXml({
    privateKey: pfx.privateKeyPem,
    publicCert: pfx.certificatePem,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: C14N,
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${pfx.certificateBase64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: refXpath,
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    transforms: [ENVELOPED, C14N],
    isEmptyUri: !options.byId,
  });
  const location =
    options.placement === 'after'
      ? { reference: refXpath, action: 'after' as const }
      : {
          reference: `//*[local-name(.)='${options.container ?? options.reference}']`,
          action: 'append' as const,
        };
  sig.computeSignature(xml, { location });
  return sig.getSignedXml();
}
