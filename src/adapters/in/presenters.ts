import { CertificateStatus } from '../../application/use-cases/certificate.service.js';
import { explainFiscalErrors } from '../../application/use-cases/fiscal-error-hints.js';
import { Invoice } from '../../domain/invoice/invoice.js';
import { Product, productWarnings } from '../../domain/product/product.js';
import { centsToDecimal } from '../../domain/shared/money.js';
import type { HmacDocumentLinks } from '../out/system.js';

/** Visão pública da nota: sem XML bruto (disponível em /xml) e com dicas para rejeições. */
export function toInvoiceView(invoice: Invoice, links?: HmacDocumentLinks) {
  const { nfse, history, ...rest } = invoice;
  return {
    ...rest,
    amount: centsToDecimal(invoice.amountCents),
    nfse: nfse && {
      provider: nfse.provider ?? 'NACIONAL',
      accessKey: nfse.accessKey,
      number: nfse.number,
      issuedAt: nfse.issuedAt,
      verificationUrl: nfse.verificationUrl,
      pdfUrl: links?.pdfUrl(invoice.id),
    },
    hints: invoice.lastErrors?.length ? explainFiscalErrors(invoice.lastErrors) : undefined,
    history: history.slice(-20),
  };
}

export function toCertificateView(status: CertificateStatus) {
  return status;
}

/** Produto com alertas (ex.: sem NBS) para REST e MCP. */
export function toProductView(product: Product) {
  return { ...product, warnings: productWarnings(product) };
}

type ConnectAbacatePayResult = Awaited<
  ReturnType<
    import('../../application/use-cases/onboarding.service.js').OnboardingService['connectAbacatePay']
  >
>;

/** Resumo da conexão com o AbacatePay (produtos resumidos + prévia das vendas antigas sem nota). */
export function toConnectAbacatePayView(result: ConnectAbacatePayResult) {
  const brief = (p: Product) => ({ id: p.id, name: p.name, externalId: p.externalId });
  return {
    ...result,
    pendingTaxReview: result.pendingTaxReview.map(brief),
    confirmedByProfile: result.confirmedByProfile.map(brief),
  };
}
