import { TaxProfile } from './tax-profile.js';

/** O que a empresa vende — define o perfil fiscal padrão dos produtos. Escopo atual: só estes dois. */
export type BusinessType = 'INFOPRODUCER' | 'MICROSAAS';
export const BUSINESS_TYPES: BusinessType[] = ['INFOPRODUCER', 'MICROSAAS'];

export interface FiscalProfileDefinition {
  businessType: BusinessType;
  label: string;
  examples: string;
  /** Tributação aplicada aos produtos (sem alíquota de ISS: ela depende do município/regime da empresa). */
  taxProfile: Partial<TaxProfile> & { nationalServiceCode: string };
  /**
   * Validado por contador? Só perfis validados confirmam a tributação automaticamente;
   * os demais entram como SUGESTÃO e o usuário confirma.
   */
  validated: boolean;
  validationNote: string;
}

export const FISCAL_PROFILES: Record<BusinessType, FiscalProfileDefinition> = {
  INFOPRODUCER: {
    businessType: 'INFOPRODUCER',
    label: 'Infoprodutor',
    examples: 'Cursos, treinamentos, mentorias',
    taxProfile: {
      nationalServiceCode: '080201',
      localServiceCode: '8.02/103911/1551',
      nbsCode: '122051900',
      issTaxation: 'TAXABLE',
      issRetention: 'NONE',
      ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
    },
    validated: true,
    validationNote:
      'Validado em 19/10/2026 (mesma tributação usada nas notas autorizadas do eNotas em SBC).',
  },
  MICROSAAS: {
    businessType: 'MICROSAAS',
    label: 'MicroSaaS',
    examples: 'Assinaturas e licenças de software',
    // Subitem 1.05 (licenciamento/cessão de uso de software): prática de mercado e SC SF/DEJUG 40/2013
    // (SP) para software em nuvem. NBS 1.1506.21.00 = "software como serviço (SaaS)", que a tabela
    // oficial de correlação (Anexo VIII v1.01) associa ao 01.05 com cIndOp 100501.
    // NÃO validado por contador: entra como sugestão até a validação.
    taxProfile: {
      nationalServiceCode: '010501',
      nbsCode: '115062100',
      issTaxation: 'TAXABLE',
      issRetention: 'NONE',
      ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100501' },
    },
    validated: false,
    validationNote:
      'Sugestão ainda não validada por contador: o usuário confirma produto a produto antes de vender.',
  },
};
