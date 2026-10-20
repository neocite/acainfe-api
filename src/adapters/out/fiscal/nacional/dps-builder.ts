import { Invoice } from '../../../../domain/invoice/invoice.js';
import { IssRetention, IssTaxation } from '../../../../domain/product/tax-profile.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { withApproximateTaxes } from '../shared/approximate-taxes.js';
import {
  approximateTaxRateBps,
  simplesRateBps,
  SpecialTaxRegime,
  Tenant,
} from '../../../../domain/tenant/tenant.js';
import {
  cleanText,
  decimal2,
  el,
  formatDateBrt,
  formatDateTimeBrt,
  LAYOUT_VERSION,
  NFSE_NS,
  rate2,
} from './xml.js';

const ISS_TAXATION: Record<IssTaxation, string> = {
  TAXABLE: '1',
  IMMUNE: '2',
  EXPORT: '3',
  NOT_LEVIED: '4',
};
const ISS_RETENTION: Record<IssRetention, string> = { NONE: '1', TOMADOR: '2', INTERMEDIARIO: '3' };
const SPECIAL_REGIME: Record<SpecialTaxRegime, string> = {
  NONE: '0',
  COOPERATIVE: '1',
  ESTIMATE: '2',
  MICROENTERPRISE_MUNICIPAL: '3',
  NOTARY: '4',
  PROFESSIONAL_SOCIETY: '6',
};

export interface DpsBuildOptions {
  appVersion: string;
  now: Date;
}

/** opSimpNac: 1 = não optante, 2 = MEI, 3 = ME/EPP. */
function simplesOption(tenant: Tenant): '1' | '2' | '3' {
  switch (tenant.taxRegime) {
    case 'MEI':
      return '2';
    case 'SIMPLES_NACIONAL':
    case 'SIMPLES_NACIONAL_EXCESSO':
      return '3';
    default:
      return '1';
  }
}

/**
 * Gera o XML do DPS (leiaute nacional v1.01) — ainda não assinado, em linha única.
 * Regras de pAliq/totTrib seguem as rejeições E0625/E0617/E0712 do Sistema Nacional.
 */
export function buildDpsXml(invoice: Invoice, tenant: Tenant, options: DpsBuildOptions): string {
  const profile = invoice.taxProfile;
  const opSimpNac = simplesOption(tenant);
  const apuration =
    opSimpNac === '3'
      ? String(
          tenant.simplesNacionalApuration ??
            (tenant.taxRegime === 'SIMPLES_NACIONAL_EXCESSO' ? 2 : 1)
        )
      : undefined;

  if (profile.federalRetentions && Object.values(profile.federalRetentions).some((v) => v)) {
    throw DomainError.validation(
      'Retenções federais (IRRF/CSLL/PIS/COFINS/INSS) ainda não são suportadas na emissão nacional pelo açaínfe'
    );
  }

  const retention = ISS_RETENTION[profile.issRetention];
  // pAliq só quando o ISS é retido (tomador/intermediário recolhe pela alíquota informada).
  let pAliq: string | undefined;
  if (
    retention !== '1' &&
    !(invoice.customer.foreign && (profile.foreignTreatment ?? 'EXPORT') === 'EXPORT')
  ) {
    if (profile.issRateBps === undefined) {
      throw DomainError.validation('issRateBps é obrigatório no produto quando o ISS é retido');
    }
    pAliq = rate2(profile.issRateBps);
  }

  let totTrib: string;
  if (opSimpNac === '3') {
    // pTotTribSN = percentual aproximado (Lei 12.741): o do produto, o configurado na empresa (IBPT,
    // confirmado pela contabilidade em 19/10/2026) ou, sem nada, a alíquota estimada do Simples.
    totTrib = el(
      'pTotTribSN',
      rate2(approximateTaxRateBps(profile, tenant) ?? simplesRateBps(tenant))
    );
  } else if (
    opSimpNac === '1' &&
    profile.approximateTaxRateBps === undefined &&
    tenant.approximateTaxes &&
    (tenant.approximateTaxes.federalRateBps ??
      tenant.approximateTaxes.stateRateBps ??
      tenant.approximateTaxes.municipalRateBps) !== undefined
  ) {
    // Detalhado por esfera (ex.: tabela IBPT), configurado na empresa.
    const t = tenant.approximateTaxes;
    totTrib = el('pTotTrib', [
      el('pTotTribFed', rate2(t.federalRateBps ?? 0)),
      el('pTotTribEst', rate2(t.stateRateBps ?? 0)),
      el('pTotTribMun', rate2(t.municipalRateBps ?? 0)),
    ]);
  } else if (opSimpNac === '1' && profile.approximateTaxRateBps !== undefined) {
    const mun = profile.issRateBps ?? 0;
    const fed = Math.max(profile.approximateTaxRateBps - mun, 0);
    totTrib = el('pTotTrib', [
      el('pTotTribFed', rate2(fed)),
      el('pTotTribEst', '0.00'),
      el('pTotTribMun', rate2(mun)),
    ]);
  } else {
    totTrib = el('indTotTrib', '0');
  }

  const customer = invoice.customer;
  const foreign = customer.foreign;
  const tomaAddress = foreign?.address
    ? el('end', [
        el('endExt', [
          el('cPais', foreign.countryCode),
          el('cEndPost', cleanText(foreign.address.postalCode, 11)),
          el('xCidade', cleanText(foreign.address.city, 60)),
          el('xEstProvReg', cleanText(foreign.address.region, 60)),
        ]),
        el('xLgr', cleanText(foreign.address.street, 255)),
        el('nro', cleanText(foreign.address.number, 60)),
        foreign.address.complement ? el('xCpl', cleanText(foreign.address.complement, 156)) : '',
        el('xBairro', cleanText(foreign.address.district, 60)),
      ])
    : !foreign && customer.address
      ? el('end', [
          el('endNac', [
            el('cMun', customer.address.cityCode),
            el('CEP', customer.address.zipCode.replace(/\D/g, '')),
          ]),
          el('xLgr', cleanText(customer.address.street, 255)),
          el('nro', cleanText(customer.address.number, 60)),
          customer.address.complement
            ? el('xCpl', cleanText(customer.address.complement, 156))
            : '',
          el('xBairro', cleanText(customer.address.district, 60)),
        ])
      : '';
  const tomaDocument = customer.taxId
    ? el(customer.taxId.kind, customer.taxId.value)
    : foreign
      ? foreign.nif
        ? el('NIF', cleanText(foreign.nif, 40))
        : el('cNaoNIF', foreign.noNifReason ?? '2')
      : '';
  const toma =
    tomaDocument &&
    el('toma', [
      tomaDocument,
      el('xNome', cleanText(customer.name ?? '', 300)),
      tomaAddress,
      customer.email ? el('email', customer.email.slice(0, 80)) : '',
    ]);

  // Tomador no exterior: grupo de comércio exterior. Valores padrão para serviço digital vendido em reais:
  // transfronteiriço, sem vínculo, moeda 790 (Real), sem mecanismos de fomento, sem envio ao MDIC.
  const comExt =
    foreign &&
    el('comExt', [
      el('mdPrestacao', '1'),
      el('vincPrest', '0'),
      el('tpMoeda', '790'),
      el('vServMoeda', decimal2(invoice.amountCents)),
      el('mecAFComexP', '01'),
      el('mecAFComexT', '01'),
      el('movTempBens', '1'),
      el('mdic', '0'),
    ]);
  const isExport = Boolean(foreign) && (profile.foreignTreatment ?? 'EXPORT') === 'EXPORT';

  // Sem documento (CPF/CNPJ/NIF) não há grupo toma, e os indicadores de operação "no domicílio do
  // adquirente" (ex.: 100301) exigem o endereço do tomador (E0234). Enquanto o IBS/CBS for opcional
  // (até 31/12/2026), consumidor não identificado sai sem o grupo. A partir de 2027 será preciso o CPF.
  const ibs = toma ? (foreign && profile.foreignIbsCbs) || profile.ibsCbs : undefined;
  const ibsCbs =
    ibs &&
    el('IBSCBS', [
      el('finNFSe', '0'),
      el('cIndOp', ibs.operationIndicator),
      el('indDest', '0'),
      el('valores', [
        el('trib', [el('gIBSCBS', [el('CST', ibs.cst), el('cClassTrib', ibs.cClassTrib)])]),
      ]),
    ]);

  const infDps = el(
    'infDPS',
    [
      el('tpAmb', tenant.environment === 'PRODUCTION' ? '1' : '2'),
      // A Sefin rejeita dhEmi no futuro; recuamos 1 minuto para absorver diferença de relógio.
      el('dhEmi', formatDateTimeBrt(new Date(options.now.getTime() - 60_000))),
      el('verAplic', options.appVersion.slice(0, 20)),
      el('serie', invoice.dps.series),
      el('nDPS', String(invoice.dps.number)),
      el('dCompet', formatDateBrt(invoice.competenceDate)),
      el('tpEmit', '1'),
      el('cLocEmi', tenant.cityCode),
      el('prest', [
        el('CNPJ', tenant.cnpj),
        tenant.sendMunicipalRegistration ? el('IM', tenant.municipalRegistration) : '',
        el('regTrib', [
          el('opSimpNac', opSimpNac),
          apuration ? el('regApTribSN', apuration) : '',
          el('regEspTrib', SPECIAL_REGIME[tenant.specialTaxRegime]),
        ]),
      ]),
      toma,
      el('serv', [
        el('locPrest', [el('cLocPrestacao', tenant.cityCode)]),
        el('cServ', [
          el('cTribNac', profile.nationalServiceCode),
          profile.municipalServiceCode ? el('cTribMun', profile.municipalServiceCode) : '',
          el('xDescServ', cleanText(withApproximateTaxes(invoice, tenant), 2000)),
          profile.nbsCode ? el('cNBS', profile.nbsCode) : '',
        ]),
        comExt,
      ]),
      el('valores', [
        el('vServPrest', [el('vServ', decimal2(invoice.amountCents))]),
        el('trib', [
          el('tribMun', [
            el('tribISSQN', isExport ? '3' : ISS_TAXATION[profile.issTaxation]),
            isExport ? el('cPaisResult', foreign!.countryCode) : '',
            el('tpRetISSQN', retention),
            pAliq ? el('pAliq', pAliq) : '',
          ]),
          el('totTrib', [totTrib]),
        ]),
      ]),
      ibsCbs,
    ],
    { Id: invoice.dps.id }
  );

  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NFSE_NS}" versao="${LAYOUT_VERSION}">${infDps}</DPS>`;
}

/** Pedido de registro de evento de cancelamento (e101101). Id = "PRE" + chave(50) + tpEvento(6). */
export function buildCancellationXml(
  accessKey: string,
  tenant: Tenant,
  reason: { code: string; description: string },
  options: DpsBuildOptions
): string {
  const description = cleanText(reason.description, 255);
  if (description.length < 15)
    throw DomainError.validation('Justificativa deve ter de 15 a 255 caracteres');
  const inf = el(
    'infPedReg',
    [
      el('tpAmb', tenant.environment === 'PRODUCTION' ? '1' : '2'),
      el('verAplic', options.appVersion.slice(0, 20)),
      el('dhEvento', formatDateTimeBrt(new Date(options.now.getTime() - 60_000))),
      el('CNPJAutor', tenant.cnpj),
      el('chNFSe', accessKey),
      el('e101101', [
        el('xDesc', 'Cancelamento de NFS-e'),
        el('cMotivo', reason.code),
        el('xMotivo', description),
      ]),
    ],
    { Id: `PRE${accessKey}101101` }
  );
  return `<?xml version="1.0" encoding="UTF-8"?><pedRegEvento xmlns="${NFSE_NS}" versao="${LAYOUT_VERSION}">${inf}</pedRegEvento>`;
}

export { withApproximateTaxes } from '../shared/approximate-taxes.js';
