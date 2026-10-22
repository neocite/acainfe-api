import { AccountantController } from './accountant/accountant.controller.js';
import { AdminBillingController } from './admin/admin-billing.controller.js';
import { AdminController } from './admin/admin.controller.js';
import { AppAccountantController } from './app/app-accountant.controller.js';
import { AppBillingController } from './app/app-billing.controller.js';
import { AppFiscalSettingsController } from './app/app-fiscal-settings.controller.js';
import { AppMcpKeysController } from './app/app-mcp-keys.controller.js';
import { AppOnboardingController } from './app/app-onboarding.controller.js';
import { AppPastSalesController } from './app/app-past-sales.controller.js';
import { AppProductsController } from './app/app-products.controller.js';
import { BillingController } from './billing/billing.controller.js';
import { CertificateUploadController } from './certificates/certificate-upload.controller.js';
import { CertificatesController } from './certificates/certificates.controller.js';
import { CustomersController } from './customers/customers.controller.js';
import { HealthController } from './health/health.controller.js';
import { InvoicesController } from './invoices/invoices.controller.js';
import { PastSalesController } from './past-sales/past-sales.controller.js';
import { ProductsController } from './products/products.controller.js';
import { PublicAccountantPackageController } from './public/accountant-package.controller.js';
import { PublicInvoicePdfController } from './public/invoice-pdf.controller.js';
import { PublicPricingController } from './public/pricing.controller.js';
import { DiscoveryController } from './discovery/discovery.controller.js';
import { RefundsController } from './sales/refunds.controller.js';
import { SalesController } from './sales/sales.controller.js';
import { LogoController } from './tenants/logo.controller.js';
import { TenantsController } from './tenants/tenants.controller.js';
import { AbacatePayWebhookController } from './webhooks/abacatepay-webhook.controller.js';
import { BillingWebhookController } from './webhooks/billing-webhook.controller.js';

export { AppUserGuard } from './shared/app-auth.js';

export { AdminGuard, ApiKeyGuard, CONTAINER, ErrorFilter } from './shared/support.js';

/**
 * Controllers REST, um por contexto:
 * - API da empresa (API key): empresa, certificados, produtos, clientes, vendas, notas, vendas passadas, cobrança, contador;
 * - app web (Replit, `/v1/app`): onboarding, produtos, cobrança, contador, vendas passadas;
 * - público, webhooks e admin.
 */
export const HTTP_CONTROLLERS = [
  HealthController,
  // API da empresa
  TenantsController,
  LogoController,
  CertificatesController,
  CertificateUploadController,
  ProductsController,
  CustomersController,
  SalesController,
  RefundsController,
  InvoicesController,
  PastSalesController,
  BillingController,
  AccountantController,
  // App web
  AppOnboardingController,
  AppMcpKeysController,
  AppFiscalSettingsController,
  AppProductsController,
  AppBillingController,
  AppAccountantController,
  AppPastSalesController,
  // Público e webhooks
  PublicInvoicePdfController,
  PublicPricingController,
  DiscoveryController,
  PublicAccountantPackageController,
  AbacatePayWebhookController,
  BillingWebhookController,
  // Admin
  AdminController,
  AdminBillingController,
];
