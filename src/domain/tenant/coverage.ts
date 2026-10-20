import { DomainError } from '../shared/domain-error.js';
import { TaxRegime } from './tenant.js';

/**
 * Cobertura do açaínfe por município: quais regimes já podem emitir.
 * Ex.: São Bernardo do Campo libera Simples/MEI (padrão nacional obrigatório desde 01/11/2026),
 * mas Lucro Presumido/Real ainda emitem pelo Ginfes (aguardando integração).
 */
export interface CityCoverage {
  cityCode: string;
  cityName?: string;
  uf?: string;
  simples: boolean;
  others: boolean;
  updatedAt: Date;
}

export type Availability = { status: 'READY' } | { status: 'WAITLIST'; reason: string };

const isSimplesFamily = (regime: TaxRegime): boolean =>
  regime === 'MEI' || regime === 'SIMPLES_NACIONAL' || regime === 'SIMPLES_NACIONAL_EXCESSO';

export function evaluateAvailability(
  coverage: CityCoverage | null,
  regime: TaxRegime,
  cityLabel: string
): Availability {
  if (!coverage || (!coverage.simples && !coverage.others)) {
    return { status: 'WAITLIST', reason: `${cityLabel} ainda não está integrado ao açaínfe` };
  }
  if (isSimplesFamily(regime) ? coverage.simples : coverage.others) return { status: 'READY' };
  return {
    status: 'WAITLIST',
    reason: isSimplesFamily(regime)
      ? `Emissão para Simples Nacional/MEI em ${cityLabel} ainda não liberada`
      : `Emissão para Lucro Presumido/Real em ${cityLabel} ainda não liberada`,
  };
}

export function coversRegime(coverage: CityCoverage, regime: TaxRegime): boolean {
  return isSimplesFamily(regime) ? coverage.simples : coverage.others;
}

export function createCoverage(input: Omit<CityCoverage, 'updatedAt'>, now: Date): CityCoverage {
  if (!/^\d{7}$/.test(input.cityCode))
    throw DomainError.validation('cityCode deve ser o código IBGE de 7 dígitos');
  return { ...input, updatedAt: now };
}
