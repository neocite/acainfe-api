import { DomainError } from '../shared/domain-error.js';
import { assertCents, Cents } from '../shared/money.js';
import { FISCAL_PROFILES } from './fiscal-profiles.js';
import { NBS_CORRELATION } from './nbs-correlation.data.js';
import { createTaxProfile, TaxProfile } from './tax-profile.js';

export interface Product {
  id: string;
  tenantId: string;
  /** Identificador do produto no sistema do cliente / gateway (ex.: id do produto no AbacatePay). */
  externalId?: string;
  /**
   * Outros ids do gateway que representam o MESMO produto (ex.: dois "Kero Avaliar" cadastrados no
   * AbacatePay). Vendas de qualquer um deles usam este produto.
   */
  aliasExternalIds?: string[];
  name: string;
  /** Texto usado na discriminação do serviço na NFS-e. */
  serviceDescription: string;
  /** Preço de referência — usado para ratear o total quando o gateway não informa preço por item. */
  defaultPriceCents?: Cents;
  /** Ausente enquanto a tributação não for definida (ex.: produto importado do gateway). */
  taxProfile?: TaxProfile;
  /** Só produtos CONFIRMED podem ser vendidos: a tributação precisa de aprovação explícita do usuário. */
  taxStatus: 'CONFIRMED' | 'PENDING_REVIEW';
  taxConfirmation?: TaxConfirmation;
  /** Sugestão vinda do serviço padrão da empresa — só vale depois de confirmada pelo usuário. */
  suggestedTaxProfile?: TaxProfile;
  /** Produto importado de um gateway de pagamento. */
  importedFrom?: { source: 'ABACATEPAY'; at: Date };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaxConfirmation {
  at: Date;
  /** API/MCP/APP = usuário confirmou; PROFILE = aplicado pelo perfil fiscal validado da empresa. */
  via: 'API' | 'MCP' | 'APP' | 'PROFILE';
  /** Justificativa registrada (ex.: CNAE que embasa o código escolhido). */
  note?: string;
}

/**
 * O que impede o produto de ser vendido (linguagem simples). Sem NBS a venda fica bloqueada: a
 * prefeitura rejeita a nota e, a partir de 2027, o NBS define a tributação de IBS/CBS.
 */
export function saleBlockers(p: Product): string[] {
  if (!p.active) return [`Produto inativo: ${p.name}.`];
  if (p.taxStatus !== 'CONFIRMED' || !p.taxProfile) {
    return [
      `Produto "${p.name}" aguarda a definição da tributação (código de serviço) pelo usuário.`,
    ];
  }
  if (!p.taxProfile.nbsCode) {
    const options = nbsOptions(p.taxProfile.nationalServiceCode);
    return [
      `Produto "${p.name}" está sem código NBS. Informe o nbsCode (9 dígitos)${
        options.length
          ? `; opções oficiais para o código ${p.taxProfile.nationalServiceCode}: ${options.join(', ')}`
          : ''
      }.`,
    ];
  }
  return [];
}

export const isSellable = (p: Product): p is Product & { taxProfile: TaxProfile } =>
  saleBlockers(p).length === 0;

/** NBS que a tabela oficial de correlação admite para o código de tributação nacional. */
export const nbsOptions = (nationalServiceCode: string): string[] =>
  NBS_CORRELATION[nationalServiceCode]?.nbs ?? [];

/**
 * Completa o NBS quando ele é inequívoco: o perfil fiscal da empresa usa o mesmo código de serviço,
 * ou a tabela oficial só admite um NBS para o código. Caso contrário fica em branco (e a venda,
 * bloqueada até o usuário escolher).
 */
export function withInferredNbs(profile: TaxProfile, companyProfile?: TaxProfile): TaxProfile {
  if (profile.nbsCode) return profile;
  // Perfil da empresa ou qualquer perfil validado com o mesmo código de serviço.
  const sameCode = [
    companyProfile,
    ...Object.values(FISCAL_PROFILES)
      .filter((p) => p.validated)
      .map((p) => p.taxProfile),
  ].find((p) => p?.nbsCode && p.nationalServiceCode === profile.nationalServiceCode);
  if (sameCode) return { ...profile, nbsCode: sameCode.nbsCode };
  const options = nbsOptions(profile.nationalServiceCode);
  return options.length === 1 ? { ...profile, nbsCode: options[0] } : profile;
}

export interface ProductInput {
  externalId?: string;
  name: string;
  serviceDescription?: string;
  defaultPriceCents?: number;
  taxProfile: Partial<TaxProfile> & { nationalServiceCode: string };
}

/** Na criação, a tributação pode ser omitida: o perfil fiscal da empresa é aplicado. */
export type NewProductInput = Omit<ProductInput, 'taxProfile'> & {
  taxProfile?: ProductInput['taxProfile'];
};

function validateBasics(input: {
  name?: string;
  serviceDescription?: string;
  defaultPriceCents?: number;
}) {
  const name = input.name?.trim();
  if (!name) throw DomainError.validation('name é obrigatório');
  const serviceDescription = (input.serviceDescription || name).trim();
  if (serviceDescription.length > 2000) {
    throw DomainError.validation('serviceDescription deve ter no máximo 2000 caracteres');
  }
  const defaultPriceCents =
    input.defaultPriceCents === undefined
      ? undefined
      : assertCents(input.defaultPriceCents, 'defaultPriceCents');
  return { name, serviceDescription, defaultPriceCents };
}

export function createProduct(
  id: string,
  tenantId: string,
  input: ProductInput,
  now: Date,
  confirmedVia: TaxConfirmation['via'] = 'API',
  note?: string
): Product {
  return {
    id,
    tenantId,
    externalId: input.externalId?.trim() || undefined,
    ...validateBasics(input),
    taxProfile: createTaxProfile(input.taxProfile),
    taxStatus: 'CONFIRMED',
    taxConfirmation: { at: now, via: confirmedVia, note },
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Volta o produto para revisão, deixando a tributação como sugestão (perfil ainda não validado). */
export function asPendingReview(product: Product, suggested?: TaxProfile): Product {
  return {
    ...product,
    taxProfile: undefined,
    taxStatus: 'PENDING_REVIEW',
    taxConfirmation: undefined,
    suggestedTaxProfile: suggested,
  };
}

/** Produto vindo do catálogo do gateway: entra sem tributação, aguardando revisão do usuário. */
export function createImportedProduct(
  id: string,
  tenantId: string,
  input: {
    externalId: string;
    name: string;
    description?: string;
    priceCents?: number;
    suggestedTaxProfile?: TaxProfile;
  },
  now: Date
): Product {
  if (!input.externalId?.trim()) throw DomainError.validation('externalId é obrigatório');
  return {
    id,
    tenantId,
    externalId: input.externalId.trim(),
    ...validateBasics({
      name: input.name,
      serviceDescription: input.description,
      defaultPriceCents: input.priceCents,
    }),
    taxStatus: 'PENDING_REVIEW',
    suggestedTaxProfile: input.suggestedTaxProfile,
    importedFrom: { source: 'ABACATEPAY', at: now },
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

export type ProductPatch = Partial<Omit<ProductInput, 'taxProfile'>> & {
  taxProfile?: Partial<TaxProfile>;
};

export function updateProduct(
  product: Product,
  patch: ProductPatch,
  now: Date,
  confirmedVia: TaxConfirmation['via'] = 'API',
  note?: string
): Product {
  const basics = validateBasics({
    name: patch.name ?? product.name,
    serviceDescription: patch.serviceDescription ?? product.serviceDescription,
    defaultPriceCents: patch.defaultPriceCents ?? product.defaultPriceCents,
  });
  const base: Product = {
    ...product,
    ...basics,
    externalId: (patch.externalId ?? product.externalId)?.trim() || undefined,
    updatedAt: now,
  };
  if (!patch.taxProfile) return base;
  const merged = { ...product.taxProfile, ...patch.taxProfile };
  if (!merged.nationalServiceCode) {
    throw DomainError.validation(
      'Informe o nationalServiceCode (cTribNac) para definir a tributação'
    );
  }
  return {
    ...base,
    taxProfile: createTaxProfile({ ...merged, nationalServiceCode: merged.nationalServiceCode }),
    taxStatus: 'CONFIRMED',
    taxConfirmation: { at: now, via: confirmedVia, note },
    suggestedTaxProfile: undefined,
  };
}

/** Alertas para o usuário: os que impedem a venda e os que só aumentam o risco de rejeição. */
export function productWarnings(product: Product): string[] {
  const warnings: string[] = [];
  const profile = product.taxProfile;
  if (profile && !profile.nbsCode) {
    warnings.push(
      'Sem código NBS: a venda fica bloqueada até você informar o nbsCode (9 dígitos), porque a prefeitura rejeita a nota sem ele.'
    );
  } else if (profile?.nbsCode) {
    const options = nbsOptions(profile.nationalServiceCode);
    if (options.length && !options.includes(profile.nbsCode)) {
      warnings.push(
        `O NBS ${profile.nbsCode} não aparece na tabela oficial de correlação para o código ${profile.nationalServiceCode} (opções: ${options.join(', ')}). Confira com seu contador.`
      );
    }
  }
  return warnings;
}

/** Nome normalizado para detectar o mesmo produto cadastrado duas vezes no gateway. */
export const normalizeProductName = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Produto de teste do gateway (não deve virar produto vendável). */
export const looksLikeTestProduct = (name: string): boolean =>
  /\b(teste?s?|test(ing)?|demo|sandbox|homolog\w*)\b/i.test(normalizeProductName(name));

/** Todos os ids do gateway que levam a este produto. */
export const productExternalIds = (p: Product): string[] =>
  [p.externalId, ...(p.aliasExternalIds ?? [])].filter((v): v is string => Boolean(v));
