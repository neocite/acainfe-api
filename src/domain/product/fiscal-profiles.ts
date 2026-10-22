import { TaxProfile } from './tax-profile.js';

/**
 * O que a empresa vende — define o perfil fiscal padrão dos produtos. CUSTOM = "Outro serviço /
 * configuro eu mesmo": sem perfil pronto; a tributação padrão da empresa (defaultService) vira só
 * sugestão e cada produto é confirmado pelo usuário.
 */
export type BusinessType = 'INFOPRODUCER' | 'MICROSAAS' | 'CUSTOM';
export type ProfileBusinessType = Exclude<BusinessType, 'CUSTOM'>;
export const BUSINESS_TYPES: BusinessType[] = ['INFOPRODUCER', 'MICROSAAS', 'CUSTOM'];

export const CUSTOM_PROFILE = {
  businessType: 'CUSTOM' as const,
  label: 'Outro serviço (configuro eu mesmo)',
  examples: 'Consultoria, design, desenvolvimento sob encomenda e outros serviços',
  validated: false,
  validationNote:
    'Você define a tributação padrão da empresa (opcional) e confirma a de cada produto antes de vender.',
};

export interface FiscalProfileDefinition {
  businessType: BusinessType;
  label: string;
  examples: string;
  /** Tributação aplicada aos produtos (sem alíquota de ISS: ela depende do município/regime da empresa). */
  taxProfile: Partial<TaxProfile> & { nationalServiceCode: string };
  /**
   * Código de tributação municipal por município (IBGE): só onde a emissão é pelo sistema da
   * prefeitura (Ginfes em São Bernardo, NFS-e Paulistana em São Paulo). No nacional não é usado.
   */
  localServiceCodes?: Record<string, string>;
  /**
   * Validado por contador? Só perfis validados confirmam a tributação automaticamente;
   * os demais entram como SUGESTÃO e o usuário confirma.
   */
  validated: boolean;
  validationNote: string;
  /**
   * Prefixos de CNAE compatíveis com o perfil. Perfil validado só confirma produtos sozinho se a
   * empresa tiver algum desses CNAEs; senão os produtos entram como sugestão (ex.: empresa de TI
   * que escolheu "Infoprodutor" por engano).
   */
  expectedCnaePrefixes: string[];
}

export const FISCAL_PROFILES: Record<ProfileBusinessType, FiscalProfileDefinition> = {
  INFOPRODUCER: {
    businessType: 'INFOPRODUCER',
    label: 'Infoprodutor',
    examples: 'Cursos, treinamentos, mentorias',
    taxProfile: {
      nationalServiceCode: '080201',
      nbsCode: '122051900',
      issTaxation: 'TAXABLE',
      issRetention: 'NONE',
      ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
    },
    localServiceCodes: {
      '3548708': '8.02/103911/1551',
      // São Paulo: 05762 "outros serviços de instrução, treinamento… de qualquer natureza" (8.02),
      // Anexo 1 da IN SF/SUREM 08/2011. Confirmar com o contador da empresa piloto.
      '3550308': '05762',
    },
    validated: true,
    validationNote:
      'Validado em 19/10/2026 (mesma tributação usada nas notas autorizadas do eNotas em SBC).',
    // Divisão 85 (educação): 8599-6/04 treinamento, 8599-6/99 outras atividades de ensino etc.
    expectedCnaePrefixes: ['85'],
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
    localServiceCodes: {
      // Validado pela contabilidade (Tactus) para a nota de uso do açaínfe em 20/10/2026.
      '3548708': '1.05/102313/1234',
      // São Paulo: 02800 licenciamento ou cessão de direito de uso de programas de computação (1.05).
      '3550308': '02800',
    },
    validated: false,
    validationNote:
      'Sugestão ainda não validada por contador: o usuário confirma produto a produto antes de vender.',
    expectedCnaePrefixes: ['6201', '6202', '6203', '6204', '6209', '6311', '6319'],
  },
};

/** A empresa tem algum CNAE compatível com o perfil? Sem CNAEs conhecidos, não bloqueia. */
export function cnaeMatchesProfile(
  cnaes: { code: string }[] | undefined,
  definition: FiscalProfileDefinition
): boolean {
  if (!cnaes?.length) return true;
  return cnaes.some((c) =>
    definition.expectedCnaePrefixes.some((p) => c.code.replace(/\D/g, '').startsWith(p))
  );
}
