import { SignedXml } from 'xml-crypto';
import { PfxContents } from '../../crypto/pfx.js';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

/**
 * Assina o elemento `elementName` (infDPS / infPedReg) conforme o padrão nacional:
 * RSA-SHA256, digest SHA-256, transforms enveloped + C14N inclusivo, Signature como irmão seguinte.
 */
export function signXml(xml: string, elementName: string, pfx: PfxContents): string {
  const xpath = `//*[local-name(.)='${elementName}']`;
  const sig = new SignedXml({
    privateKey: pfx.privateKeyPem,
    publicCert: pfx.certificatePem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: C14N,
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${pfx.certificateBase64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N],
  });
  sig.computeSignature(xml, { location: { reference: xpath, action: 'after' } });
  return sig.getSignedXml();
}
