import { McpServer } from '@modelcontextprotocol/server';
import type { Container } from '../../../config/container.js';
import { Tenant } from '../../../domain/tenant/tenant.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerCompanyTools } from './tools/company.js';
import { registerCertificateTools } from './tools/certificate.js';
import { registerProductTools } from './tools/products.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerSaleTools } from './tools/sales.js';
import { registerPastSalesTools } from './tools/past-sales.js';
import { registerAccountantTools } from './tools/accountant.js';
import { registerBillingTools } from './tools/billing.js';

/** Cria um servidor MCP vinculado à empresa autenticada (stateless: um por requisição). */
export function buildMcpServer(c: Container, tenant: Tenant): McpServer {
  const server = new McpServer(
    { name: 'acainfe', title: 'açaínfe', version: c.env.APP_VERSION },
    { instructions: INSTRUCTIONS }
  );

  registerCompanyTools(server, c, tenant);
  registerCertificateTools(server, c, tenant);
  registerProductTools(server, c, tenant);
  registerInvoiceTools(server, c, tenant);
  registerCustomerTools(server, c, tenant);
  registerSaleTools(server, c, tenant);
  registerPastSalesTools(server, c, tenant);
  registerAccountantTools(server, c, tenant);
  registerBillingTools(server, c, tenant);
  registerPrompts(server);
  return server;
}
