import { DomainError } from '../shared/domain-error.js';
import { createCustomer, Customer, CustomerInput } from '../sale/customer.js';

/** Cliente (tomador) cadastrado pela empresa — reutilizado em vendas futuras. */
export interface CustomerRecord extends Customer {
  id: string;
  tenantId: string;
  /** Id do cliente no sistema de origem (ex.: cust_... do AbacatePay). */
  externalId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomerRecordInput = CustomerInput & { externalId?: string };

export function createCustomerRecord(
  id: string,
  tenantId: string,
  input: CustomerRecordInput,
  now: Date
): CustomerRecord {
  const data = createCustomer(input);
  if (!data.name && !data.taxId && !data.foreign && !data.email && !data.phone) {
    throw DomainError.validation('Informe ao menos nome, CPF/CNPJ, e-mail ou WhatsApp do cliente');
  }
  return {
    ...data,
    id,
    tenantId,
    externalId: input.externalId?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateCustomerRecord(
  record: CustomerRecord,
  patch: Partial<CustomerRecordInput>,
  now: Date
): CustomerRecord {
  const merged = createCustomerRecord(
    record.id,
    record.tenantId,
    {
      externalId: patch.externalId ?? record.externalId,
      name: patch.name ?? record.name,
      taxId: patch.foreign ? undefined : (patch.taxId ?? record.taxId?.value),
      foreign: patch.taxId ? undefined : (patch.foreign ?? record.foreign),
      email: patch.email ?? record.email,
      phone: patch.phone ?? record.phone,
      address: patch.address ?? record.address,
    },
    record.createdAt
  );
  return { ...merged, updatedAt: now };
}

/** Dados do cadastro + dados informados na venda (os da venda prevalecem). */
export function mergeCustomer(record: Customer, inline: Customer): Customer {
  const inlineHasDoc = Boolean(inline.taxId || inline.foreign);
  return {
    taxId: inlineHasDoc ? inline.taxId : record.taxId,
    foreign: inlineHasDoc ? inline.foreign : record.foreign,
    name: inline.name ?? record.name,
    email: inline.email ?? record.email,
    phone: inline.phone ?? record.phone,
    address: inline.address ?? record.address,
  };
}

export function toCustomerData(record: CustomerRecord): Customer {
  const { taxId, foreign, name, email, phone, address } = record;
  return { taxId, foreign, name, email, phone, address };
}
