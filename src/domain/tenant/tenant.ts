import {
  BUSINESS_TYPES,
  BusinessType,
  cnaeMatchesProfile,
  CUSTOM_PROFILE,
  FISCAL_PROFILES,
} from '../product/fiscal-profiles.js';
import { createTaxProfile, TaxProfile } from '../product/tax-profile.js';
import { DomainError } from '../shared/domain-error.js';
import { normalizeBrazilianPhone, normalizeEmail, parseCnpj } from '../shared/document.js';

/** Regime tributário do prestador (impacta opSimpNac/regApTribSN no DPS). */
export type TaxRegime =
  'MEI' | 'SIMPLES_NACIONAL' | 'SIMPLES_NACIONAL_EXCESSO' | 'LUCRO_PRESUMIDO' | 'LUCRO_REAL';

/** regEspTrib do leiaute nacional. */
export type SpecialTaxRegime =
  | 'NONE'
  | 'COOPERATIVE'
  | 'ESTIMATE'
  | 'MICROENTERPRISE_MUNICIPAL'
  | 'NOTARY'
  | 'PROFESSIONAL_SOCIETY';

export type FiscalEnvironment = 'PRODUCTION' | 'HOMOLOGATION';

export interface Address {
  street: string;
  number: string;
  complement?: string;
  district: string;
  /** Código IBGE do município (7 dígitos). */
  cityCode: string;
  zipCode: string;
}

export interface Tenant {
  id: string;
  cnpj: string;
  legalName: string;
  tradeName?: string;
  /** Inscrição municipal (CCM). Não vem do certificado nem da Receita: o usuário informa. */
  municipalRegistration?: string;
  /** Município do prestador (IBGE), descoberto pelo CNPJ no onboarding. */
  cityCode: string;
  cityName?: string;
  uf?: string;
  /** ACTIVE = pode emitir; WAITLIST = município/regime ainda não liberado (avisamos quando liberar). */
  status: TenantStatus;
  waitlist?: { reason: string; since: Date };
  activatedAt?: Date;
  /** Atividades econômicas (Receita): orientam o agente de IA na escolha do código de serviço. */
  cnaes: Cnae[];
  /** Percentual aproximado de tributos (Lei 12.741/2012) exibido na nota. */
  approximateTaxes?: ApproximateTaxes;
  /** Serviço padrão: sugestão de tributação para produtos importados (o usuário ainda confirma). */
  defaultService?: { taxProfile: TaxProfile; serviceDescription?: string };
  /** O que a empresa vende: define o perfil fiscal padrão dos produtos. */
  businessType?: BusinessType;
  /**
   * Força o sistema de emissão (ex.: NACIONAL quando a prefeitura liberar o Emissor Nacional).
   * Ausente = regra do município (GINFES_CITIES / PAULISTANA_CITIES).
   */
  fiscalProvider?: FiscalSystem;
  /**
   * Alíquota de ISS da empresa (pontos-base). Ausente no Simples = calculada a partir da alíquota do Simples
   * (parcela de ISS do Anexo III); fora do Simples precisa ser informada se o município não publicar.
   */
  issRateBps?: number;
  /** Contador: recebe todo mês os PDFs, XMLs e a planilha das notas do mês anterior. */
  accountant?: Accountant;
  /** Incentivador cultural (campo do padrão ABRASF/Ginfes). */
  culturalIncentive?: boolean;
  /**
   * Numeração confirmada pelo usuário. Quem já emite por outro sistema precisa de série própria
   * (ou do próximo número), senão o DPS colide com notas existentes.
   */
  numberingConfirmedAt?: Date;
  /** Usuários (login do app) que administram a empresa. */
  ownerUserIds: string[];
  taxRegime: TaxRegime;
  /**
   * regApTribSN (obrigatório para ME/EPP): 1 = tributos federais e ISS pelo SN;
   * 2 = federais pelo SN e ISS fora; 3 = ambos fora.
   */
  simplesNacionalApuration?: 1 | 2 | 3;
  /** Alíquota efetiva do Simples em pontos-base (6% = 600), usada em pTotTribSN quando o produto não informar. */
  simplesNacionalTaxRateBps?: number;
  specialTaxRegime: SpecialTaxRegime;
  /** Enviar IM no DPS (alguns municípios rejeitam se o CNC não exigir — E0120). */
  sendMunicipalRegistration: boolean;
  environment: FiscalEnvironment;
  email: string;
  phone?: string;
  address?: Address;
  /** Série do DPS (até 5 dígitos). */
  dpsSeries: string;
  /** Último número de DPS alocado; incrementado atomicamente pelo repositório. */
  lastDpsNumber: number;
  notifications: { email: boolean; whatsapp: boolean };
  integrations: {
    abacatepay?: {
      webhookSecret: string;
      encryptedApiKey?: string;
      webhookId?: string;
      /** URL do webhook cadastrado no AbacatePay (sem o segredo): mostra se ficou desatualizada. */
      webhookEndpoint?: string;
      connectedAt?: Date;
      /** Produto usado quando o pagamento não informa o produto (ex.: Pix transparente sem itens). */
      defaultProductId?: string;
      /** Quando o usuário escolheu o produto padrão — ou decidiu não ter um (sem defaultProductId). */
      defaultProductDecidedAt?: Date;
    };
  };
  apiKeyHashes: string[];
  /**
   * Metadados das chaves (nunca a chave em si): nome, final, criação e último uso. Chaves antigas
   * podem existir só em `apiKeyHashes`, sem registro aqui.
   */
  apiKeys?: ApiKeyRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRecord {
  /** SHA-256 da chave (o mesmo de `apiKeyHashes`). */
  hash: string;
  label?: string;
  /** Últimos 4 caracteres, para o usuário reconhecer a chave. */
  last4: string;
  /** Ausente em chave antiga registrada no primeiro uso (a data de criação não foi guardada). */
  createdAt?: Date;
  createdVia?: 'APP' | 'API' | 'ADMIN';
  lastUsedAt?: Date;
}

/** Id público da chave: começo do hash (não permite reconstruir a chave). */
export const apiKeyId = (hash: string): string => hash.slice(0, 12);

/** Número máximo de chaves ativas por empresa. */
export const MAX_API_KEYS = 10;

export const TAX_REGIMES: TaxRegime[] = [
  'MEI',
  'SIMPLES_NACIONAL',
  'SIMPLES_NACIONAL_EXCESSO',
  'LUCRO_PRESUMIDO',
  'LUCRO_REAL',
];

export const SAO_BERNARDO_DO_CAMPO = '3548708';

export type TenantStatus = 'ACTIVE' | 'WAITLIST';

export interface Accountant {
  name?: string;
  email?: string;
  /** 55DDDNUMERO */
  whatsapp?: string;
  /** Envio automático mensal (padrão: ligado). */
  monthlyReport: boolean;
  /** Dia do mês do envio (1 a 28; padrão 1). */
  dayOfMonth: number;
}

export function createAccountant(input: {
  name?: string;
  email?: string;
  whatsapp?: string;
  monthlyReport?: boolean;
  dayOfMonth?: number;
}): Accountant {
  const email = input.email?.trim() ? normalizeEmail(input.email) : undefined;
  const whatsapp = input.whatsapp?.trim() ? normalizeBrazilianPhone(input.whatsapp) : undefined;
  if (!email && !whatsapp)
    throw DomainError.validation('Informe o e-mail ou o WhatsApp do contador');
  const dayOfMonth = input.dayOfMonth ?? 1;
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
    throw DomainError.validation('dayOfMonth deve estar entre 1 e 28');
  }
  return {
    name: input.name?.trim() || undefined,
    email,
    whatsapp,
    monthlyReport: input.monthlyReport ?? true,
    dayOfMonth,
  };
}

export interface ApproximateTaxes {
  /** Percentual total simplificado em pontos-base (15,53% do IBPT = 1553). */
  rateBps?: number;
  /** Detalhado por esfera, em pontos-base (ex.: IBPT). */
  federalRateBps?: number;
  stateRateBps?: number;
  municipalRateBps?: number;
  /** Fonte exibida (padrão "IBPT"). */
  source?: string;
  /**
   * Texto acrescentado à discriminação do serviço. Tags: [ValorTributos] e [PercentualTributos].
   * Ex.: "Valor aprox. dos tributos: R$ [ValorTributos] ([PercentualTributos]%). Fonte: IBPT".
   */
  descriptionTemplate?: string;
}

/** Série exclusiva sugerida para quem já emite por outro sistema (evita colisão de numeração). */
export const EXCLUSIVE_DPS_SERIES = '900';
export const MAX_DPS_NUMBER = 999_999_999_999_999;

export interface Cnae {
  code: string;
  description: string;
  primary: boolean;
}

export interface TenantInput {
  cnpj: string;
  legalName: string;
  tradeName?: string;
  municipalRegistration?: string;
  cityCode?: string;
  cityName?: string;
  uf?: string;
  status?: TenantStatus;
  waitlistReason?: string;
  cnaes?: Cnae[];
  ownerUserIds?: string[];
  taxRegime: TaxRegime;
  simplesNacionalApuration?: 1 | 2 | 3;
  simplesNacionalTaxRateBps?: number;
  specialTaxRegime?: SpecialTaxRegime;
  sendMunicipalRegistration?: boolean;
  environment?: FiscalEnvironment;
  email: string;
  phone?: string;
  address?: Address;
  dpsSeries?: string;
  notifications?: { email?: boolean; whatsapp?: boolean };
  approximateTaxes?: ApproximateTaxes;
  defaultService?: { taxProfile: TaxProfile; serviceDescription?: string };
  culturalIncentive?: boolean;
  numberingConfirmed?: boolean;
  accountant?: Parameters<typeof createAccountant>[0];
  businessType?: BusinessType;
  issRateBps?: number;
  fiscalProvider?: FiscalSystem;
}

export function createTenant(
  id: string,
  input: TenantInput,
  apiKeyHash: string | undefined,
  now: Date
): Tenant {
  const cityCode = input.cityCode ?? SAO_BERNARDO_DO_CAMPO;
  if (!/^\d{7}$/.test(cityCode)) {
    throw DomainError.validation(`Código IBGE do município inválido: ${cityCode}`, { cityCode });
  }
  if (!TAX_REGIMES.includes(input.taxRegime)) {
    throw DomainError.validation(`taxRegime inválido: ${input.taxRegime}`);
  }
  if (!input.legalName?.trim()) throw DomainError.validation('legalName é obrigatório');
  const municipalRegistration = input.municipalRegistration?.replace(/\D/g, '') || undefined;
  if (
    input.municipalRegistration !== undefined &&
    input.municipalRegistration !== '' &&
    !municipalRegistration
  ) {
    throw DomainError.validation('municipalRegistration deve conter dígitos');
  }
  const status = input.status ?? 'ACTIVE';
  if (
    input.simplesNacionalApuration !== undefined &&
    ![1, 2, 3].includes(input.simplesNacionalApuration)
  ) {
    throw DomainError.validation('simplesNacionalApuration deve ser 1, 2 ou 3');
  }
  const rate = input.simplesNacionalTaxRateBps;
  if (rate !== undefined && (!Number.isInteger(rate) || rate < 0 || rate > 3_300)) {
    throw DomainError.validation(
      'simplesNacionalTaxRateBps deve ser inteiro em pontos-base entre 0 e 3300 (6% = 600; 6,25% = 625)'
    );
  }
  const dpsSeries = input.dpsSeries ?? '1';
  if (!/^\d{1,5}$/.test(dpsSeries))
    throw DomainError.validation('dpsSeries deve ter de 1 a 5 dígitos');
  return {
    id,
    cnpj: parseCnpj(input.cnpj),
    legalName: input.legalName.trim(),
    tradeName: input.tradeName?.trim(),
    municipalRegistration,
    cityCode,
    cityName: input.cityName,
    uf: input.uf,
    status,
    waitlist:
      status === 'WAITLIST'
        ? { reason: input.waitlistReason ?? 'Município em integração', since: now }
        : undefined,
    activatedAt: status === 'ACTIVE' ? now : undefined,
    cnaes: input.cnaes ?? [],
    approximateTaxes: validateApproximateTaxes(input.approximateTaxes),
    defaultService: input.defaultService,
    culturalIncentive: input.culturalIncentive,
    accountant: input.accountant ? createAccountant(input.accountant) : undefined,
    businessType: validateBusinessType(input.businessType),
    fiscalProvider: input.fiscalProvider,
    issRateBps: validateIssRate(input.issRateBps),
    numberingConfirmedAt: input.numberingConfirmed ? now : undefined,
    ownerUserIds: input.ownerUserIds ?? [],
    taxRegime: input.taxRegime,
    simplesNacionalApuration:
      input.taxRegime === 'SIMPLES_NACIONAL' ? (input.simplesNacionalApuration ?? 1) : undefined,
    simplesNacionalTaxRateBps: rate,
    specialTaxRegime: input.specialTaxRegime ?? 'NONE',
    sendMunicipalRegistration: input.sendMunicipalRegistration ?? true,
    environment: input.environment ?? 'HOMOLOGATION',
    email: normalizeEmail(input.email),
    phone: input.phone,
    address: input.address,
    dpsSeries,
    lastDpsNumber: 0,
    notifications: {
      email: input.notifications?.email ?? true,
      whatsapp: input.notifications?.whatsapp ?? true,
    },
    integrations: {},
    apiKeyHashes: apiKeyHash ? [apiKeyHash] : [],
    createdAt: now,
    updatedAt: now,
  };
}

export const isSimplesNacional = (regime: TaxRegime): boolean =>
  regime === 'MEI' || regime === 'SIMPLES_NACIONAL' || regime === 'SIMPLES_NACIONAL_EXCESSO';

export interface Readiness {
  canIssue: boolean;
  /** Pendências que IMPEDEM a emissão (linguagem simples, para o app e para o agente de IA). */
  missing: { field: string; message: string }[];
  /** Recomendações que NÃO impedem a emissão (dá para completar depois, com calma). */
  recommended: { field: string; message: string }[];
}

/**
 * Alíquota usada em pTotTribSN quando a empresa ainda não informou a sua: 6% (1ª faixa do Anexo III do Simples,
 * a da maioria dos serviços digitais/educação no início). É só o percentual APROXIMADO da Lei 12.741 —
 * o imposto de verdade é apurado no DAS, fora da nota.
 */
export const DEFAULT_SIMPLES_RATE_BPS = 600;

const isSimplesMeEpp = (regime: TaxRegime): boolean =>
  regime === 'SIMPLES_NACIONAL' || regime === 'SIMPLES_NACIONAL_EXCESSO';

/** Alíquota do Simples para o DPS: a informada ou a estimativa padrão. */
export const simplesRateBps = (tenant: Tenant): number =>
  tenant.simplesNacionalTaxRateBps ?? DEFAULT_SIMPLES_RATE_BPS;

/** O que falta para a empresa emitir notas. */
export function tenantReadiness(
  tenant: Tenant,
  hasUsableCertificate: boolean,
  options: {
    /** O sistema da prefeitura exige a inscrição municipal (ex.: Ginfes de São Bernardo). */
    municipalRegistrationRequired?: boolean;
  } = {}
): Readiness {
  const missing: Readiness['missing'] = [];
  if (tenant.status === 'WAITLIST') {
    missing.push({
      field: 'status',
      message: `Na lista de espera: ${tenant.waitlist?.reason ?? 'município em integração'}`,
    });
  }
  if (!hasUsableCertificate)
    missing.push({ field: 'certificate', message: 'Envie um certificado A1 válido' });
  if (!tenant.numberingConfirmedAt) {
    missing.push({
      field: 'numbering',
      message:
        'Confirme a numeração das notas: você já emite NFS-e por outro sistema (eNotas, portal da prefeitura…)?',
    });
  }
  if (!tenant.businessType) {
    missing.push({
      field: 'businessType',
      message:
        'O que você vende? Infoprodutor (cursos, treinamentos, mentorias) ou MicroSaaS (assinaturas de software)',
    });
  }
  // Só pergunta quando a prefeitura não publica a alíquota (consultada ao definir o tipo de venda)
  // e ela não pode ser calculada a partir do Simples.
  if (
    tenant.businessType &&
    tenant.taxRegime !== 'MEI' &&
    companyIssRateBps(tenant) === undefined
  ) {
    missing.push({
      field: 'issRateBps',
      message:
        'Informe a alíquota de ISS do seu município (2% a 5%); não encontramos o dado publicado pela prefeitura',
    });
  }
  if (options.municipalRegistrationRequired && !tenant.municipalRegistration) {
    missing.push({
      field: 'municipalRegistration',
      message:
        'Informe a inscrição municipal (CCM): o sistema da sua prefeitura não emite a nota sem ela. Está no alvará ou no cadastro da prefeitura.',
    });
  }
  const recommended: Readiness['recommended'] = [];
  // No padrão nacional os dados do prestador vêm do cadastro nacional (CNC) da prefeitura:
  // a inscrição municipal só é exigida no DPS em alguns municípios. Emitimos sem ela e, se a
  // prefeitura recusar por falta dela, pedimos nesse momento.
  if (!tenant.municipalRegistration && !options.municipalRegistrationRequired) {
    recommended.push({
      field: 'municipalRegistration',
      message:
        'Inscrição municipal (CCM): opcional. Se a prefeitura exigir, avisamos na primeira nota. Está no alvará ou no cadastro da prefeitura.',
    });
  }
  if (isSimplesMeEpp(tenant.taxRegime) && tenant.simplesNacionalTaxRateBps === undefined) {
    recommended.push({
      field: 'simplesNacionalTaxRateBps',
      message:
        'Alíquota efetiva do Simples (do DAS): usando 6% como estimativa para calcular o ISS informado na nota (2,01%). Não muda o imposto que você paga. Ajuste quando souber.',
    });
  }
  const a = tenant.approximateTaxes;
  if (!a?.descriptionTemplate || a.rateBps === undefined) {
    recommended.push({
      field: 'approximateTaxes',
      message:
        'Tributos aproximados (Lei 12.741): a nota deve trazer "Valor aprox. dos tributos: R$ X. Fonte: IBPT". Confirme o percentual com seu contador (serviços: 15,53% na tabela do IBPT).',
    });
  }
  if (tenant.integrations.abacatepay && !tenant.integrations.abacatepay.defaultProductDecidedAt) {
    recommended.push({
      field: 'defaultProduct',
      message:
        'Produto padrão do AbacatePay: quando um pagamento chega sem produto (ex.: Pix transparente), qual produto vai na nota? Escolha um ou "nenhum" (aí esses pagamentos não geram nota).',
    });
  }
  return { canIssue: missing.length === 0, missing, recommended };
}

export function activateTenant(tenant: Tenant, now: Date): Tenant {
  if (tenant.status === 'ACTIVE') return tenant;
  return { ...tenant, status: 'ACTIVE', waitlist: undefined, activatedAt: now, updatedAt: now };
}

function validateApproximateTaxes(t?: ApproximateTaxes): ApproximateTaxes | undefined {
  if (!t) return undefined;
  for (const [k, v] of Object.entries({
    rateBps: t.rateBps,
    federalRateBps: t.federalRateBps,
    stateRateBps: t.stateRateBps,
    municipalRateBps: t.municipalRateBps,
  })) {
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 10_000))
      throw DomainError.validation(
        `approximateTaxes.${k} deve ser inteiro em pontos-base (15,53% = 1553)`
      );
  }
  if (t.descriptionTemplate && t.descriptionTemplate.length > 300) {
    throw DomainError.validation(
      'approximateTaxes.descriptionTemplate deve ter até 300 caracteres'
    );
  }
  return t;
}

/** Percentual aproximado de tributos a exibir: produto → empresa (simplificado ou soma do detalhado) → alíquota do Simples. */
export function approximateTaxRateBps(profile: TaxProfile, tenant: Tenant): number | undefined {
  if (profile.approximateTaxRateBps !== undefined) return profile.approximateTaxRateBps;
  const t = tenant.approximateTaxes;
  if (t?.rateBps !== undefined) return t.rateBps;
  if (t && (t.federalRateBps ?? t.stateRateBps ?? t.municipalRateBps) !== undefined) {
    return (t.federalRateBps ?? 0) + (t.stateRateBps ?? 0) + (t.municipalRateBps ?? 0);
  }
  return isSimplesMeEpp(tenant.taxRegime)
    ? simplesRateBps(tenant)
    : tenant.simplesNacionalTaxRateBps;
}

/** Define série/próximo número. Na mesma série nunca volta para trás (evitaria DPS duplicado). */
export function planNumbering(
  tenant: Tenant,
  input: { series?: string; nextNumber?: number }
): { series: string; lastNumber: number } {
  const series = (input.series ?? tenant.dpsSeries).trim();
  if (!/^\d{1,5}$/.test(series)) throw DomainError.validation('A série deve ter de 1 a 5 dígitos');
  const sameSeries = Number(series) === Number(tenant.dpsSeries);
  if (input.nextNumber === undefined)
    return { series, lastNumber: sameSeries ? tenant.lastDpsNumber : 0 };
  if (
    !Number.isInteger(input.nextNumber) ||
    input.nextNumber < 1 ||
    input.nextNumber > MAX_DPS_NUMBER
  ) {
    throw DomainError.validation('O próximo número deve ser um inteiro positivo');
  }
  if (sameSeries && input.nextNumber <= tenant.lastDpsNumber) {
    throw DomainError.validation(
      `Na série ${series} o açaínfe já usou até o número ${tenant.lastDpsNumber}; informe um número maior ou outra série`
    );
  }
  return { series, lastNumber: input.nextNumber - 1 };
}

function validateBusinessType(value?: BusinessType): BusinessType | undefined {
  if (value !== undefined && !BUSINESS_TYPES.includes(value)) {
    throw DomainError.validation(`businessType deve ser ${BUSINESS_TYPES.join(' ou ')}`);
  }
  return value;
}

function validateIssRate(value?: number): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 500)) {
    throw DomainError.validation(
      'issRateBps deve ser inteiro em pontos-base entre 0 e 500 (2,01% = 201)'
    );
  }
  return value;
}

/**
 * Parcela do ISS dentro da alíquota do Simples (Anexo III, 1ª faixa: 33,5%).
 * 6% × 33,5% = 2,01% — a "alíquota de ISS" que aparece nas notas de quem está no Simples.
 */
export const SIMPLES_ANEXO_III_ISS_SHARE_BPS = 3_350;

/**
 * Alíquota de ISS efetiva da empresa: informada, ou estimada a partir do Simples (parcela do ISS na
 * 1ª faixa do Anexo III), limitada a 2%–5% como manda a LC 123 (art. 18, §14) e a LC 116.
 */
export function companyIssRateBps(tenant: Tenant): number | undefined {
  if (tenant.issRateBps !== undefined) return tenant.issRateBps;
  if (isSimplesMeEpp(tenant.taxRegime)) {
    const share = Math.round((simplesRateBps(tenant) * SIMPLES_ANEXO_III_ISS_SHARE_BPS) / 10_000);
    return Math.min(500, Math.max(200, share));
  }
  return undefined;
}

export interface CompanyFiscalProfile {
  definition: { businessType: BusinessType; label: string; validated: boolean };
  taxProfile: TaxProfile;
  /**
   * Confirma os produtos sozinho? Só perfil validado e coerente com os CNAEs da empresa. Os demais
   * (perfil não validado, CNAE incompatível, "Outro serviço") entram como sugestão.
   */
  autoConfirm: boolean;
  /** Por que não confirmou sozinho, quando o perfil é validado mas os CNAEs não batem. */
  warning?: string;
}

/**
 * Tributação padrão da empresa (pelo que ela vende), já com a alíquota de ISS da empresa. Em
 * "Outro serviço" vem da tributação padrão que o próprio usuário definiu (defaultService), se houver.
 */
export function companyFiscalProfile(tenant: Tenant): CompanyFiscalProfile | undefined {
  if (!tenant.businessType) return undefined;
  if (tenant.businessType === 'CUSTOM') {
    const own = tenant.defaultService?.taxProfile;
    if (!own) return undefined;
    return {
      definition: CUSTOM_PROFILE,
      taxProfile: createTaxProfile({
        ...own,
        issRateBps: own.issRateBps ?? companyIssRateBps(tenant),
      }),
      autoConfirm: false,
    };
  }
  const definition = FISCAL_PROFILES[tenant.businessType];
  const coherent = cnaeMatchesProfile(tenant.cnaes, definition);
  return {
    definition,
    taxProfile: createTaxProfile({
      ...definition.taxProfile,
      localServiceCode: definition.localServiceCodes?.[tenant.cityCode],
      issRateBps: companyIssRateBps(tenant),
    }),
    autoConfirm: definition.validated && coherent,
    warning:
      definition.validated && !coherent
        ? `Nenhum CNAE da empresa é compatível com o perfil "${definition.label}" (${definition.examples.toLowerCase()}). Os produtos entram como sugestão: confira o que você vende e confirme cada um, ou escolha "${CUSTOM_PROFILE.label}".`
        : undefined,
  };
}

export type FiscalSystem = 'NACIONAL' | 'GINFES' | 'PAULISTANA';

/**
 * Por onde a empresa emite: o escolhido na empresa ou a regra do município. MEI usa sempre o
 * Emissor Nacional (obrigatório para MEI); ME/EPP de municípios ainda fora do Emissor Nacional
 * usam o sistema da prefeitura (Ginfes em São Bernardo, NFS-e Paulistana na capital).
 */
export function fiscalSystemFor(
  tenant: Tenant,
  ginfesCities: string[],
  paulistanaCities: string[] = [],
  /**
   * Virada para o Emissor Nacional (Resolução CGSN 191/2026: Simples a partir de 01/11/2026):
   * competência a partir de `cutover` (AAAA-MM-DD, Brasília) vai para o nacional; antes disso o
   * sistema da prefeitura continua (emissão retroativa).
   */
  timing: { at?: Date; cutover?: string } = {}
): FiscalSystem {
  if (tenant.fiscalProvider === 'NACIONAL' || tenant.taxRegime === 'MEI') return 'NACIONAL';
  const municipal =
    tenant.fiscalProvider ??
    (paulistanaCities.includes(tenant.cityCode)
      ? 'PAULISTANA'
      : ginfesCities.includes(tenant.cityCode)
        ? 'GINFES'
        : 'NACIONAL');
  if (municipal === 'NACIONAL' || !timing.cutover) return municipal;
  const day = new Date((timing.at ?? new Date()).getTime() - 3 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  return day >= timing.cutover ? 'NACIONAL' : municipal;
}
