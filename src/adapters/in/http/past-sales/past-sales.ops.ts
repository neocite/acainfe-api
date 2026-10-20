import type { Container } from '../../../../config/container.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import {
  PastSalesApplyReconciliationSchema,
  PastSalesIgnoreSchema,
  PastSalesIssueSchema,
  PastSalesListSchema,
  PastSalesMarkSchema,
  PastSalesReconcileSchema,
  PastSalesScanSchema,
} from '../../schemas.js';
import { parseInput } from '../shared/support.js';

/** Operações compartilhadas entre a API da empresa (API key) e o app (usuário logado). */
export class PastSalesOps {
  constructor(private readonly c: Container) {}
  scan(tenant: Tenant, body: unknown) {
    return this.c.pastSales.scan(tenant, parseInput(PastSalesScanSchema, body).monthsBack ?? 3);
  }
  summary(tenant: Tenant) {
    return this.c.pastSales.summary(tenant).then((periods) => ({ periods }));
  }
  list(tenant: Tenant, query: unknown) {
    return this.c.pastSales.list(tenant, parseInput(PastSalesListSchema, query));
  }
  mark(tenant: Tenant, body: unknown) {
    const input = parseInput(PastSalesMarkSchema, body);
    return this.c.pastSales.setAlreadyIssued(
      tenant,
      { ids: input.ids, period: input.period },
      input.alreadyIssued
    );
  }
  ignore(tenant: Tenant, body: unknown) {
    const input = parseInput(PastSalesIgnoreSchema, body);
    return this.c.pastSales.setIgnored(
      tenant,
      { ids: input.ids, period: input.period },
      input.ignored,
      input.reason
    );
  }
  issue(tenant: Tenant, body: unknown) {
    return this.c.pastSales.issue(tenant, parseInput(PastSalesIssueSchema, body));
  }
  reconcile(tenant: Tenant, query: unknown) {
    return this.c.pastSales.reconcile(tenant, parseInput(PastSalesReconcileSchema, query).period);
  }
  applyReconciliation(tenant: Tenant, body: unknown) {
    return this.c.pastSales.applyReconciliation(
      tenant,
      parseInput(PastSalesApplyReconciliationSchema, body)
    );
  }
}
