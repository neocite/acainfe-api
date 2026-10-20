import {
  createCustomerRecord,
  CustomerRecord,
  CustomerRecordInput,
  mergeCustomer,
  toCustomerData,
  updateCustomerRecord,
} from '../../domain/customer/customer-record.js';
import { createCustomer, Customer, CustomerInput } from '../../domain/sale/customer.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { CustomerFilter, CustomerRepository, Page } from '../ports/repositories.js';
import { Clock, IdGenerator, Logger } from '../ports/services.js';

export class CustomerService {
  constructor(
    private readonly deps: {
      customers: CustomerRepository;
      clock: Clock;
      ids: IdGenerator;
      logger: Logger;
    }
  ) {}

  async create(tenantId: string, input: CustomerRecordInput): Promise<CustomerRecord> {
    const record = createCustomerRecord(
      this.deps.ids.next(),
      tenantId,
      input,
      this.deps.clock.now()
    );
    const existing = await this.deps.customers.findMatch(tenantId, {
      taxId: record.taxId?.value,
      externalId: record.externalId,
    });
    if (existing) {
      throw new DomainError('CONFLICT', 'Já existe cliente com este CPF/CNPJ ou externalId', {
        customerId: existing.id,
      });
    }
    await this.deps.customers.create(record);
    return record;
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<CustomerRecordInput>
  ): Promise<CustomerRecord> {
    const updated = updateCustomerRecord(
      await this.get(tenantId, id),
      patch,
      this.deps.clock.now()
    );
    await this.deps.customers.update(updated);
    return updated;
  }

  async get(tenantId: string, id: string): Promise<CustomerRecord> {
    const record = await this.deps.customers.findById(tenantId, id);
    if (!record) throw DomainError.notFound('Cliente', id);
    return record;
  }

  list(tenantId: string, filter: CustomerFilter): Promise<Page<CustomerRecord>> {
    return this.deps.customers.list(tenantId, filter);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    // As notas guardam uma cópia dos dados do tomador; excluir o cadastro não altera notas emitidas.
    if (!(await this.deps.customers.delete(tenantId, id)))
      throw DomainError.notFound('Cliente', id);
  }

  /**
   * Resolve o tomador de uma venda: usa o cliente cadastrado (customerId) e/ou os dados informados.
   * Dados novos viram cadastro automaticamente, para o próximo "emita nota para a Maria" funcionar.
   */
  async resolveForSale(
    tenantId: string,
    customerId: string | undefined,
    inline: CustomerInput & { externalId?: string } = {}
  ): Promise<{ customer: Customer; customerId?: string }> {
    const data = createCustomer(inline);
    if (customerId) {
      const record = await this.get(tenantId, customerId);
      return { customer: mergeCustomer(toCustomerData(record), data), customerId: record.id };
    }
    const hasIdentity = data.taxId || data.email || data.phone || inline.externalId;
    if (!hasIdentity) return { customer: data };
    try {
      const existing = await this.deps.customers.findMatch(tenantId, {
        taxId: data.taxId?.value,
        externalId: inline.externalId,
        email: data.email,
        phone: data.phone,
      });
      if (existing) {
        const merged = mergeCustomer(toCustomerData(existing), data);
        const refreshed = { ...existing, ...merged, updatedAt: this.deps.clock.now() };
        await this.deps.customers.update(refreshed);
        return { customer: merged, customerId: existing.id };
      }
      const record = createCustomerRecord(
        this.deps.ids.next(),
        tenantId,
        { ...inline },
        this.deps.clock.now()
      );
      await this.deps.customers.create(record);
      return { customer: data, customerId: record.id };
    } catch (error) {
      // O cadastro automático é conveniência: nunca deve impedir a emissão.
      this.deps.logger.warn('Falha ao cadastrar cliente automaticamente', {
        tenantId,
        error: String(error),
      });
      return { customer: data };
    }
  }
}
