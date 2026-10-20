import { DomainError } from '../shared/domain-error.js';
import { normalizeBrazilianPhone, normalizeEmail, parseTaxId, TaxId } from '../shared/document.js';
import { Address } from '../tenant/tenant.js';

/** Tomador do serviço. Em SBC/nacional o documento do tomador é opcional (consumidor final). */
/** Tomador no exterior (venda para estrangeiro / brasileiro sem CPF). */
export interface ForeignCustomer {
  /** País ISO 3166-1 alfa-2 (ex.: US, PT). */
  countryCode: string;
  /** Número de identificação fiscal no país de origem. */
  nif?: string;
  /** Sem NIF: 0 = não informado na origem, 1 = dispensado, 2 = não exigido. */
  noNifReason?: '0' | '1' | '2';
  address?: {
    street: string;
    number: string;
    complement?: string;
    district: string;
    city: string;
    region: string;
    postalCode: string;
  };
}

export interface Customer {
  taxId?: TaxId;
  foreign?: ForeignCustomer;
  name?: string;
  email?: string;
  /** Formato 55DDDNUMERO. */
  phone?: string;
  address?: Address;
}

export interface CustomerInput {
  foreign?: ForeignCustomer;
  taxId?: string;
  name?: string;
  email?: string;
  phone?: string;
  address?: Address;
}

const FOREIGN_PHONE_RE = /^\d{8,15}$/;

function createForeign(input: ForeignCustomer): ForeignCustomer {
  const countryCode = input.countryCode?.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode ?? ''))
    throw DomainError.validation('foreign.countryCode deve ser o código ISO de 2 letras (ex.: US)');
  if (countryCode === 'BR')
    throw DomainError.validation('Tomador no Brasil deve usar CPF/CNPJ, não foreign');
  const nif = input.nif?.trim() || undefined;
  if (nif && nif.length > 40)
    throw DomainError.validation('foreign.nif deve ter até 40 caracteres');
  if (input.noNifReason && !['0', '1', '2'].includes(input.noNifReason)) {
    throw DomainError.validation('foreign.noNifReason deve ser 0, 1 ou 2');
  }
  return {
    countryCode,
    nif,
    noNifReason: nif ? undefined : (input.noNifReason ?? '2'),
    address: input.address,
  };
}

export function createCustomer(input: CustomerInput = {}): Customer {
  if (input.foreign) {
    if (input.taxId && /\d/.test(input.taxId) && !input.taxId.includes('*')) {
      throw DomainError.validation(
        'Informe CPF/CNPJ (tomador no Brasil) ou foreign (tomador no exterior), não os dois'
      );
    }
    if (!input.name?.trim())
      throw DomainError.validation('name do tomador é obrigatório para tomador no exterior');
    const phone = input.phone?.replace(/\D/g, '');
    if (phone && !FOREIGN_PHONE_RE.test(phone))
      throw DomainError.validation(`Telefone inválido: ${input.phone}`);
    return {
      foreign: createForeign(input.foreign),
      name: input.name.trim(),
      email: input.email ? normalizeEmail(input.email) : undefined,
      phone: phone || undefined,
    };
  }
  const taxId =
    input.taxId && /\d/.test(input.taxId) && !input.taxId.includes('*')
      ? parseTaxId(input.taxId)
      : undefined;
  if (taxId && !input.name?.trim()) {
    throw DomainError.validation('name do tomador é obrigatório quando taxId é informado');
  }
  return {
    taxId,
    name: input.name?.trim() || undefined,
    email: input.email ? normalizeEmail(input.email) : undefined,
    phone: input.phone ? normalizeBrazilianPhone(input.phone) : undefined,
    address: input.address,
  };
}
