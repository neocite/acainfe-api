import { PfxContents } from '../../crypto/pfx.js';
import { signEnvelopedSha1 } from '../shared/xmldsig.js';

/** Assinatura do Ginfes (como ACBr e sped-nfse-ginfes): ver signEnvelopedSha1. */
export const signGinfes = signEnvelopedSha1;

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
