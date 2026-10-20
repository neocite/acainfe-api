import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { DanfseRenderer } from '../../../application/ports/services.js';
import { Invoice } from '../../../domain/invoice/invoice.js';
import { applyBps, formatBps, formatBRL } from '../../../domain/shared/money.js';
import { Logo } from '../../../domain/tenant/logo.js';
import { approximateTaxRateBps, Tenant } from '../../../domain/tenant/tenant.js';
import { summarizeGinfesXml } from '../fiscal/ginfes/ginfes-parser.js';
import { summarizeNfseXml } from '../fiscal/nacional/nfse-xml-parser.js';

pdfmake.setFonts({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
});
// Só as fontes padrão do PDF são necessárias: bloqueia downloads e qualquer outra leitura de disco.
const STANDARD_FONTS = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
]);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((path) => STANDARD_FONTS.has(path));

const formatTaxId = (kind: 'CPF' | 'CNPJ', v: string): string =>
  kind === 'CPF'
    ? v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

type Margin = [number, number, number, number];

const formatKey = (key: string): string => key.replace(/(\d{4})(?=\d)/g, '$1 ');

const brDate = (d: Date): string =>
  d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });

function section(title: string, rows: [string, string | undefined][]): Content {
  return {
    table: {
      widths: ['*'],
      body: [
        [{ text: title, style: 'sectionTitle', fillColor: '#eeeeee' }],
        [
          {
            columns: rows
              .filter(([, v]) => v)
              .map(([label, value]) => ({
                stack: [
                  { text: label, style: 'label' },
                  { text: value!, style: 'value' },
                ],
              })),
            columnGap: 8,
          },
        ],
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 6],
  };
}

/**
 * DANFSe gerado localmente (a API pública do Sistema Nacional foi descontinuada em ago/2026),
 * inspirado no leiaute da NT 008/2026: A4, chave de acesso, QR Code de consulta pública
 * e tarja para notas canceladas.
 */
export class PdfmakeDanfseRenderer implements DanfseRenderer {
  async render(invoice: Invoice, tenant: Tenant, options: { logo?: Logo } = {}): Promise<Buffer> {
    if (!invoice.nfse) throw new Error('Nota ainda não emitida');
    const nfse = invoice.nfse;
    const ginfes = nfse.provider === 'GINFES';
    const summary = ginfes ? summarizeGinfesXml(nfse.xml) : summarizeNfseXml(nfse.xml);
    const customer = invoice.customer;
    const cancelled = invoice.status === 'CANCELLED';
    const profile = invoice.taxProfile;

    const definition: TDocumentDefinitions = {
      pageSize: 'A4',
      pageMargins: [28, 28, 28, 28],
      info: { title: `DANFSe ${nfse.number}`, author: 'açaínfe' },
      watermark: cancelled
        ? { text: 'CANCELADA', color: 'red', opacity: 0.25, bold: true }
        : undefined,
      defaultStyle: { font: 'Helvetica', fontSize: 8 },
      styles: {
        title: { fontSize: 13, bold: true },
        sectionTitle: { bold: true, fontSize: 8 },
        label: { fontSize: 6.5, color: '#555555' },
        value: { fontSize: 8.5 },
      },
      content: [
        {
          columns: [
            ...(options.logo
              ? [
                  {
                    width: 110,
                    image: `data:${options.logo.contentType};base64,${options.logo.data.toString('base64')}`,
                    fit: [100, 60] as [number, number],
                    margin: [0, 0, 10, 0] as [number, number, number, number],
                  },
                ]
              : []),
            {
              width: '*',
              stack: [
                {
                  text: ginfes
                    ? `NFS-e — Prefeitura de ${tenant.cityName ?? 'São Bernardo do Campo'}`
                    : 'DANFSe — Documento Auxiliar da NFS-e',
                  style: 'title',
                },
                {
                  text: `NFS-e nº ${nfse.number}   •   Emitida em ${brDate(nfse.issuedAt)}`,
                  margin: [0, 4, 0, 0],
                },
                {
                  text: `Competência: ${invoice.competenceDate.toISOString().slice(0, 7)}   •   ${summary.municipality ?? ''}`,
                },
                ...(ginfes
                  ? [
                      {
                        text: 'Código de verificação',
                        style: 'label',
                        margin: [0, 6, 0, 0] as Margin,
                      },
                      { text: nfse.accessKey, bold: true },
                    ]
                  : [
                      { text: 'Chave de acesso', style: 'label', margin: [0, 6, 0, 0] as Margin },
                      { text: formatKey(nfse.accessKey), bold: true },
                    ]),
                tenant.environment === 'HOMOLOGATION'
                  ? {
                      text: 'AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL',
                      color: 'red',
                      bold: true,
                      margin: [0, 4, 0, 0],
                    }
                  : '',
              ],
            },
            {
              width: 90,
              stack: [
                { qr: nfse.verificationUrl, fit: 88 },
                { text: 'Consulta pública', style: 'label', alignment: 'center' },
              ],
            },
          ],
          margin: [0, 0, 0, 10],
        },
        section('PRESTADOR DO SERVIÇO', [
          ['Razão social', summary.issuerName ?? tenant.legalName],
          ['CNPJ', formatTaxId('CNPJ', tenant.cnpj)],
          ['Inscrição municipal', tenant.municipalRegistration],
          ['Endereço', summary.issuerAddress],
        ]),
        section('TOMADOR DO SERVIÇO', [
          ['Nome', customer.name ?? 'Consumidor não identificado'],
          [
            'CPF/CNPJ',
            customer.taxId ? formatTaxId(customer.taxId.kind, customer.taxId.value) : undefined,
          ],
          ['País', customer.foreign?.countryCode],
          ['NIF', customer.foreign ? (customer.foreign.nif ?? 'Não informado') : undefined],
          [
            'Endereço',
            customer.address
              ? `${customer.address.street}, ${customer.address.number}${customer.address.complement ? ` ${customer.address.complement}` : ''}, ${customer.address.district} — CEP ${customer.address.zipCode.replace(/^(\d{5})(\d{3})$/, '$1-$2')}`
              : undefined,
          ],
          ['E-mail', customer.email],
        ]),
        section('SERVIÇO', [
          [
            'Código de tributação nacional',
            `${profile.nationalServiceCode}${summary.serviceName ? ` — ${summary.serviceName}` : ''}`,
          ],
          ['Código municipal', profile.municipalServiceCode],
          ['NBS', profile.nbsCode],
        ]),
        {
          table: {
            widths: ['*'],
            body: [
              [{ text: 'DISCRIMINAÇÃO DO SERVIÇO', style: 'sectionTitle', fillColor: '#eeeeee' }],
              [{ text: invoice.serviceDescription }],
            ],
          },
          layout: 'lightHorizontalLines',
          margin: [0, 0, 0, 6],
        },
        section('VALORES', [
          ['Valor do serviço', formatBRL(invoice.amountCents)],
          ['Base de cálculo', summary.issBase ? `R$ ${summary.issBase}` : undefined],
          [
            'Alíquota ISS',
            summary.issRateText
              ? `${summary.issRateText.replace('.', ',')}%`
              : profile.issRateBps !== undefined
                ? `${formatBps(profile.issRateBps)}%`
                : undefined,
          ],
          ['Valor do ISS', summary.issValue ? `R$ ${summary.issValue}` : undefined],
          ['ISS retido', profile.issRetention === 'NONE' ? 'Não' : 'Sim'],
          [
            'Valor líquido',
            summary.netValue ? `R$ ${summary.netValue}` : formatBRL(invoice.amountCents),
          ],
        ]),
        approximateTaxesLine(invoice, tenant),
        cancelled && invoice.cancellation
          ? {
              text: `NFS-e CANCELADA em ${brDate(invoice.cancellation.at)}: ${invoice.cancellation.reason}`,
              color: 'red',
              bold: true,
            }
          : '',
        {
          text: `Autenticidade: ${nfse.verificationUrl}\nDocumento gerado por açaínfe`,
          style: 'label',
          margin: [0, 10, 0, 0],
        },
      ],
    };
    return pdfmake.createPdf(definition).getBuffer();
  }
}

/** Lei 12.741/2012: valor aproximado dos tributos visível ao consumidor. */
function approximateTaxesLine(invoice: Invoice, tenant: Tenant): Content {
  const rate = approximateTaxRateBps(invoice.taxProfile, tenant);
  if (rate === undefined) return '';
  const value = applyBps(invoice.amountCents, rate);
  const source = tenant.approximateTaxes?.source ?? 'IBPT';
  return {
    text: `Valor aproximado dos tributos: ${formatBRL(value)} (${formatBps(rate)}%). Fonte: ${source}. Lei 12.741/2012.`,
    style: 'label',
    margin: [0, 2, 0, 6],
  };
}
