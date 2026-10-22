import {
  asPendingReview,
  createProduct,
  NewProductInput,
  Product,
  ProductPatch,
  TaxConfirmation,
  updateProduct,
  withInferredNbs,
} from '../../domain/product/product.js';
import { NBS_CORRELATION } from '../../domain/product/nbs-correlation.data.js';
import { createTaxProfile, TaxProfile } from '../../domain/product/tax-profile.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { companyFiscalProfile, Tenant } from '../../domain/tenant/tenant.js';

const withInferredProductNbs = (p: Product, hint?: TaxProfile): Product =>
  p.taxProfile ? { ...p, taxProfile: withInferredNbs(p.taxProfile, hint) } : p;
import { MunicipalParamsGateway, MunicipalServiceParams } from '../ports/fiscal-provider.js';
import { Page, ProductFilter, ProductRepository } from '../ports/repositories.js';
import { Clock, IdGenerator, ServiceCode, ServiceCodeCatalog } from '../ports/services.js';
import { CertificateService } from './certificate.service.js';

export class ProductService {
  constructor(
    private readonly deps: {
      products: ProductRepository;
      catalog: ServiceCodeCatalog;
      municipalParams: MunicipalParamsGateway;
      certificates: CertificateService;
      clock: Clock;
      ids: IdGenerator;
    }
  ) {}

  /**
   * Cria o produto. Sem `taxProfile`, aplica o perfil fiscal da empresa (pelo que ela vende):
   * perfil validado entra confirmado; perfil ainda não validado entra como sugestão para revisão.
   * Com `taxProfile`, o NBS é completado quando inequívoco.
   */
  async create(
    tenant: Tenant,
    input: NewProductInput,
    via: TaxConfirmation['via'] = 'API'
  ): Promise<Product> {
    const company = companyFiscalProfile(tenant);
    const now = this.deps.clock.now();
    const id = this.deps.ids.next();
    let product: Product;
    if (input.taxProfile) {
      const taxProfile = withInferredNbs(createTaxProfile(input.taxProfile), company?.taxProfile);
      product = createProduct(id, tenant.id, { ...input, taxProfile }, now, via);
    } else if (!company) {
      throw DomainError.validation(
        'Informe a tributação (taxProfile) ou defina antes o que a empresa vende (businessType) — em "Outro serviço", a tributação padrão da empresa (defaultService) — para aplicarmos o perfil fiscal padrão'
      );
    } else {
      const base = createProduct(
        id,
        tenant.id,
        { ...input, taxProfile: company.taxProfile },
        now,
        'PROFILE',
        `Perfil fiscal padrão: ${company.definition.label}`
      );
      product = company.autoConfirm ? base : asPendingReview(base, company.taxProfile);
    }
    await this.assertUniqueExternalId(tenant.id, product.externalId);
    await this.deps.products.create(product);
    return product;
  }

  async update(
    tenant: Tenant,
    id: string,
    patch: ProductPatch,
    via: TaxConfirmation['via'] = 'API'
  ): Promise<Product> {
    const tenantId = tenant.id;
    const current = await this.get(tenant.id, id);
    const updated = withInferredProductNbs(
      updateProduct(current, patch, this.deps.clock.now(), via),
      companyFiscalProfile(tenant)?.taxProfile
    );
    if (updated.externalId !== current.externalId)
      await this.assertUniqueExternalId(tenantId, updated.externalId);
    await this.deps.products.update(updated);
    return updated;
  }

  async get(tenantId: string, id: string): Promise<Product> {
    const product = await this.deps.products.findById(tenantId, id);
    if (!product) throw DomainError.notFound('Produto', id);
    return product;
  }

  list(tenantId: string, filter: ProductFilter): Promise<Page<Product>> {
    return this.deps.products.list(tenantId, filter);
  }

  /**
   * Confirma a tributação de um produto (ex.: importado do AbacatePay). Exige confirmação explícita
   * do usuário: ele não é contador, e a escolha do código de serviço é responsabilidade dele.
   */
  async confirmTax(
    tenant: Tenant,
    id: string,
    taxProfile: Partial<TaxProfile> & { nationalServiceCode: string },
    confirmation: { userConfirmed: boolean; note?: string; via: TaxConfirmation['via'] }
  ): Promise<Product> {
    if (!confirmation.userConfirmed) {
      throw DomainError.validation(
        'Confirme com o usuário o código de serviço e a alíquota antes de salvar (userConfirmed: true)'
      );
    }
    const current = await this.get(tenant.id, id);
    const updated = withInferredProductNbs(
      updateProduct(
        current,
        { taxProfile },
        this.deps.clock.now(),
        confirmation.via,
        confirmation.note
      ),
      current.suggestedTaxProfile ?? companyFiscalProfile(tenant)?.taxProfile
    );
    await this.deps.products.update(updated);
    return updated;
  }

  /** Desativa (soft delete) — notas antigas continuam referenciando o produto. */
  async deactivate(tenantId: string, id: string): Promise<Product> {
    const product = await this.get(tenantId, id);
    const updated = { ...product, active: false, updatedAt: this.deps.clock.now() };
    await this.deps.products.update(updated);
    return updated;
  }

  searchServiceCodes(query: string, limit = 20): ServiceCode[] {
    return this.deps.catalog.search(query, limit).map((code) => {
      const official = NBS_CORRELATION[code.nationalServiceCode];
      return official
        ? { ...code, nbsOptions: official.nbs, operationIndicators: official.indOp }
        : code;
    });
  }

  /** Consulta a parametrização municipal (alíquota) do código de serviço na API nacional. */
  async municipalParams(
    tenant: Tenant,
    nationalServiceCode: string
  ): Promise<MunicipalServiceParams | null> {
    const code = nationalServiceCode.replace(/\D/g, '');
    if (!/^\d{6}$/.test(code))
      throw DomainError.validation('nationalServiceCode deve ter 6 dígitos');
    const certificate = await this.deps.certificates.loadMaterial(tenant);
    return this.deps.municipalParams.get(tenant.cityCode, code, this.deps.clock.now(), {
      tenant,
      certificate,
    });
  }

  private async assertUniqueExternalId(tenantId: string, externalId?: string): Promise<void> {
    if (!externalId) return;
    const [existing] = await this.deps.products.findManyByExternalIds(tenantId, [externalId]);
    if (existing) {
      throw new DomainError('CONFLICT', `Já existe produto com externalId ${externalId}`, {
        productId: existing.id,
      });
    }
  }
}
