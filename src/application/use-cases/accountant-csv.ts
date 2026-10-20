import { Invoice } from '../../domain/invoice/invoice.js';
import { applyBps, bpsToDecimal, centsToPlainDecimal } from '../../domain/shared/money.js';

/**
 * Planilha mensal no MESMO layout exportado pelo eNotas ("Planilha Notas Emitidas"), para o contador
 * continuar usando a importação que já tem. Separador ";", UTF-8 com BOM (abre direto no Excel).
 */
export const ACCOUNTANT_CSV_HEADER = [
  'Cliente_NomeRazaoSocial',
  'Cliente_NomeFantasia',
  'Cliente_Documento',
  'Cliente_Email',
  'Cliente_EnderecoCidadeCodigoIBGE',
  'Cliente_EnderecoCidade',
  'Cliente_EnderecoUF',
  'Cliente_EnderecoCEP',
  'Cliente_Endereco',
  'Cliente_EnderecoNumero',
  'Cliente_EnderecoComplemento',
  'Cliente_EnderecoBairro',
  'Cliente_EnderecoPais',
  'Cliente_Telefone',
  'Cliente_TipoPessoa',
  'Cliente_InscricaoMunicipal',
  'Cliente_InscricaoEstadual',
  'NFe_ValorTotal',
  'NFe_CNAE',
  'NFe_CodigoServicoMunicipio',
  'NFe_ItemListaServicoLC116',
  'NFe_ValorCOFINS',
  'NFe_ValorPIS',
  'NFe_ValorCSLL',
  'NFe_ValorINSS',
  'NFe_ValorIR',
  'NFe_ValorISS',
  'NFe_AliquotaISS',
  'NFe_ISSRetido',
  'NFe_Discriminacao',
  'NFe_NumeroPrefeitura',
  'NFe_CodigoVerificacao',
  'NFe_Situacao',
  'NFe_DataAutorizacao',
  'NFe_ChaveAcesso',
  'NFe_CFOP',
  'IDExterno',
];

const BRT_OFFSET_MS = -3 * 3_600_000;

const cell = (value: string | undefined): string => {
  const v = value ?? '';
  return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const formatDocument = (kind: 'CPF' | 'CNPJ', v: string): string =>
  kind === 'CPF'
    ? v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
    : v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

/** "080201" → "8.02" (item da lista da LC 116). */
export const lc116Item = (nationalServiceCode: string): string =>
  `${Number(nationalServiceCode.slice(0, 2))}.${nationalServiceCode.slice(2, 4)}`;

const brtDateTime = (d: Date): string => {
  const b = new Date(d.getTime() + BRT_OFFSET_MS).toISOString();
  return `${b.slice(8, 10)}-${b.slice(5, 7)}-${b.slice(0, 4)} ${b.slice(11, 16)}`;
};

const dot = (cents: number): string => centsToPlainDecimal(cents);
const comma = (cents: number): string => dot(cents).replace('.', ',');

export interface AccountantCsvRow {
  invoice: Invoice;
  saleExternalId?: string;
}

export function buildAccountantCsv(rows: AccountantCsvRow[]): Buffer {
  const lines = [ACCOUNTANT_CSV_HEADER.join(';')];
  const sorted = [...rows].sort(
    (a, b) => Number(a.invoice.nfse?.number ?? 0) - Number(b.invoice.nfse?.number ?? 0)
  );
  for (const { invoice, saleExternalId } of sorted) {
    const c = invoice.customer;
    const p = invoice.taxProfile;
    const issCents = p.issRateBps !== undefined ? applyBps(invoice.amountCents, p.issRateBps) : 0;
    const foreign = c.foreign;
    const phone = c.phone?.startsWith('55') && !foreign ? c.phone.slice(2) : c.phone;
    lines.push(
      [
        c.name,
        '',
        c.taxId ? formatDocument(c.taxId.kind, c.taxId.value) : foreign?.nif,
        c.email,
        foreign ? '' : c.address?.cityCode,
        foreign?.address?.city ?? '',
        foreign?.address?.region ?? '',
        foreign?.address?.postalCode ?? c.address?.zipCode,
        foreign?.address?.street ?? c.address?.street,
        foreign?.address?.number ?? c.address?.number,
        foreign?.address?.complement ?? c.address?.complement,
        foreign?.address?.district ?? c.address?.district,
        foreign ? foreign.countryCode : c.taxId || c.address ? 'Brasil' : '',
        phone,
        c.taxId?.kind === 'CNPJ' ? 'PJ' : 'PF',
        '',
        '',
        comma(invoice.amountCents),
        '',
        p.localServiceCode ?? p.municipalServiceCode ?? '',
        lc116Item(p.nationalServiceCode),
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        dot(issCents),
        p.issRateBps !== undefined ? bpsToDecimal(p.issRateBps) : '',
        p.issRetention === 'NONE' ? 'Não' : 'Sim',
        invoice.serviceDescription,
        invoice.nfse?.number,
        '',
        invoice.status === 'CANCELLED' ? 'Cancelada' : 'Autorizada',
        invoice.nfse ? brtDateTime(invoice.nfse.issuedAt) : '',
        invoice.nfse?.accessKey,
        '',
        saleExternalId,
      ]
        .map(cell)
        .join(';')
    );
  }
  return Buffer.concat([
    Buffer.from('﻿', 'utf8'),
    Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'),
  ]);
}
