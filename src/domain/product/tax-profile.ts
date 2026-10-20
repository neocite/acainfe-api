import { DomainError } from '../shared/domain-error.js';

/** tribISSQN do leiaute nacional. */
export type IssTaxation = 'TAXABLE' | 'IMMUNE' | 'EXPORT' | 'NOT_LEVIED';
/** tpRetISSQN: quem recolhe o ISS. */
export type IssRetention = 'NONE' | 'TOMADOR' | 'INTERMEDIARIO';

export interface FederalRetentions {
  /** Pontos-base (0,65% = 65). Ausente = não retido. */
  irrfRateBps?: number;
  csllRateBps?: number;
  pisRateBps?: number;
  cofinsRateBps?: number;
  inssRateBps?: number;
}

export interface IbsCbsProfile {
  /** CST do IBS/CBS (3 dígitos). */
  cst: string;
  /** Código de classificação tributária (6 dígitos). */
  cClassTrib: string;
  /** Indicador da operação de fornecimento (cIndOp, 6 dígitos — tabela da NT 007/2026). */
  operationIndicator: string;
}

/**
 * Perfil tributário de um produto/serviço. É o coração do diferencial do açaínfe:
 * cada produto carrega sua própria tributação e itens com perfis diferentes viram notas diferentes.
 */
export interface TaxProfile {
  /** Código de tributação nacional (cTribNac) — 6 dígitos: item LC 116 (2) + subitem (2) + desdobro (2). */
  nationalServiceCode: string;
  /** Código de tributação municipal (cTribMun) — 3 dígitos, quando o município exige. */
  municipalServiceCode?: string;
  /** Nomenclatura Brasileira de Serviços (cNBS) — 9 dígitos. */
  nbsCode?: string;
  /** Alíquota de ISS em pontos-base (200 a 500 = 2% a 5%; 2,01% = 201). Opcional para Simples quando o município parametriza. */
  issRateBps?: number;
  issTaxation: IssTaxation;
  issRetention: IssRetention;
  federalRetentions?: FederalRetentions;
  /** Percentual aproximado de tributos (Lei 12.741/2012) em pontos-base (15,53% = 1553). */
  approximateTaxRateBps?: number;
  ibsCbs?: IbsCbsProfile;
  /**
   * Venda para tomador no exterior: EXPORT (padrão) = exportação de serviço (tribISSQN 3, ISS não incide)
   * quando o resultado ocorre fora do país; TAXABLE = tributa normalmente. Confirme com o contador.
   */
  foreignTreatment?: 'EXPORT' | 'TAXABLE';
  /** IBS/CBS para vendas ao exterior (classificação e indicador de operação "exterior"). */
  foreignIbsCbs?: IbsCbsProfile;
  /** Código de serviço no sistema próprio da prefeitura (ABRASF/Ginfes, ex.: "8.02/103911/1551"). */
  localServiceCode?: string;
}

/** Percentual inteiro em pontos-base (0..max). */
const isBps = (v: number | undefined, max = 10_000): boolean =>
  v === undefined || (Number.isInteger(v) && v >= 0 && v <= max);

export function createTaxProfile(
  input: Partial<TaxProfile> & { nationalServiceCode: string }
): TaxProfile {
  const nationalServiceCode = input.nationalServiceCode.replace(/\D/g, '');
  if (!/^\d{6}$/.test(nationalServiceCode)) {
    throw DomainError.validation('nationalServiceCode (cTribNac) deve ter 6 dígitos', {
      value: input.nationalServiceCode,
    });
  }
  if (input.municipalServiceCode !== undefined && !/^\d{3}$/.test(input.municipalServiceCode)) {
    throw DomainError.validation('municipalServiceCode (cTribMun) deve ter 3 dígitos');
  }
  if (input.nbsCode !== undefined && !/^\d{9}$/.test(input.nbsCode.replace(/\D/g, ''))) {
    throw DomainError.validation('nbsCode (cNBS) deve ter 9 dígitos');
  }
  if (
    input.issRateBps !== undefined &&
    (!isBps(input.issRateBps) || input.issRateBps < 200 || input.issRateBps > 500)
  ) {
    throw DomainError.validation(
      'issRateBps deve ser inteiro em pontos-base entre 200 e 500 (2% a 5%; ex.: 2,01% = 201)',
      {
        value: input.issRateBps,
      }
    );
  }
  const fr = input.federalRetentions;
  if (
    fr &&
    ![fr.irrfRateBps, fr.csllRateBps, fr.pisRateBps, fr.cofinsRateBps, fr.inssRateBps].every((r) =>
      isBps(r, 3_000)
    )
  ) {
    throw DomainError.validation('federalRetentions com percentual inválido');
  }
  if (!isBps(input.approximateTaxRateBps))
    throw DomainError.validation('approximateTaxRateBps inválido');
  if (
    input.localServiceCode !== undefined &&
    (input.localServiceCode.trim().length === 0 || input.localServiceCode.length > 40)
  ) {
    throw DomainError.validation('localServiceCode deve ter de 1 a 40 caracteres');
  }
  if (
    input.foreignTreatment !== undefined &&
    !['EXPORT', 'TAXABLE'].includes(input.foreignTreatment)
  ) {
    throw DomainError.validation('foreignTreatment deve ser EXPORT ou TAXABLE');
  }
  for (const [label, g] of [
    ['ibsCbs', input.ibsCbs],
    ['foreignIbsCbs', input.foreignIbsCbs],
  ] as const) {
    if (
      g &&
      (!/^\d{3}$/.test(g.cst) ||
        !/^\d{6}$/.test(g.cClassTrib) ||
        !/^\d{6}$/.test(g.operationIndicator))
    ) {
      throw DomainError.validation(
        `${label} requer cst (3 dígitos), cClassTrib (6 dígitos) e operationIndicator/cIndOp (6 dígitos)`
      );
    }
  }
  return {
    nationalServiceCode,
    municipalServiceCode: input.municipalServiceCode,
    nbsCode: input.nbsCode?.replace(/\D/g, ''),
    issRateBps: input.issRateBps,
    issTaxation: input.issTaxation ?? 'TAXABLE',
    issRetention: input.issRetention ?? 'NONE',
    federalRetentions: fr,
    approximateTaxRateBps: input.approximateTaxRateBps,
    ibsCbs: input.ibsCbs,
    foreignTreatment: input.foreignTreatment,
    foreignIbsCbs: input.foreignIbsCbs,
    localServiceCode: input.localServiceCode?.trim(),
  };
}

/**
 * Chave determinística: dois itens só podem ir na mesma NFS-e se tiverem exatamente
 * a mesma tributação (código, alíquota, retenções, IBS/CBS).
 */
export function taxProfileKey(profile: TaxProfile): string {
  const fr = profile.federalRetentions ?? {};
  return [
    profile.nationalServiceCode,
    profile.municipalServiceCode ?? '',
    profile.nbsCode ?? '',
    profile.issRateBps ?? '',
    profile.issTaxation,
    profile.issRetention,
    fr.irrfRateBps ?? '',
    fr.csllRateBps ?? '',
    fr.pisRateBps ?? '',
    fr.cofinsRateBps ?? '',
    fr.inssRateBps ?? '',
    profile.ibsCbs?.cst ?? '',
    profile.ibsCbs?.cClassTrib ?? '',
    profile.ibsCbs?.operationIndicator ?? '',
    profile.foreignTreatment ?? '',
    profile.foreignIbsCbs
      ? `${profile.foreignIbsCbs.cst}/${profile.foreignIbsCbs.cClassTrib}/${profile.foreignIbsCbs.operationIndicator}`
      : '',
    profile.localServiceCode ?? '',
  ].join('|');
}
