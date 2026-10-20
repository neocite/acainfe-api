import { SignedXml } from 'xml-crypto';
import { PfxContents } from '../../crypto/pfx.js';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/**
 * Assinatura do Ginfes (como ACBr e sped-nfse-ginfes): RSA-SHA1, digest SHA1, C14N inclusivo.
 * - `reference`: elemento assinado. Com Id (ex.: LoteRps) a referência é `#Id`; sem Id, `URI=""`.
 * - `placement`: `after` = Signature como irmão seguinte; `append` = último filho de `container`.
 */
export function signGinfes(
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

/** Lote: assina LoteRps (#Lote_n) e põe a Signature logo depois dele, dentro do EnviarLoteRpsEnvio. */
export const signLote = (xml: string, pfx: PfxContents): string =>
  signGinfes(xml, pfx, { reference: 'LoteRps', placement: 'after', byId: true });

/** Consultas: assina o elemento raiz inteiro (URI="") e anexa a Signature como último filho. */
export const signRoot = (xml: string, root: string, pfx: PfxContents): string =>
  signGinfes(xml, pfx, { reference: root, placement: 'append', byId: false });

/**
 * Cancelamento v3: Signature dentro do Pedido (como o ACBr). Com URI="" a referência é o documento
 * inteiro (o enveloped-signature remove a própria Signature), então o digest cobre a raiz.
 */
export const signCancelV3 = (xml: string, pfx: PfxContents): string =>
  signGinfes(xml, pfx, {
    reference: 'CancelarNfseEnvio',
    placement: 'append',
    container: 'Pedido',
    byId: false,
  });
