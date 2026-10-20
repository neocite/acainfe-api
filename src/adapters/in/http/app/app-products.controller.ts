import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { FISCAL_PROFILES } from '../../../../domain/product/fiscal-profiles.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { toProductView } from '../../presenters.js';
import { CreateProductSchema, TaxProfileSchema } from '../../schemas.js';
import { AppHeaders, AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import { schema } from '../shared/openapi.js';
import { CONTAINER, parseInput } from '../shared/support.js';

const AppConfirmTaxSchema = z.object({
  taxProfile: TaxProfileSchema.optional().describe('Omita para confirmar a sugestão do produto'),
  userConfirmed: z.literal(true).describe('O usuário clicou em confirmar'),
  note: z.string().max(500).optional(),
});

@ApiTags('app (onboarding)')
@AppHeaders()
@UseGuards(AppUserGuard)
@Controller('v1/app')
export class AppProductsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('companies/:tenantId/products')
  @ApiOperation({
    summary: 'Produtos da empresa (?pendingTaxReview=true para os que aguardam definição no MCP)',
  })
  async products(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Query('pendingTaxReview') pending?: string
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    const page = await this.c.products.list(tenant.id, {
      pendingTaxReview: pending === 'true',
      pageSize: 100,
    });
    return { ...page, items: page.items.map(toProductView) };
  }

  @Post('companies/:tenantId/products')
  @ApiOperation({
    summary:
      'Cadastra um produto. Sem taxProfile, aplica o perfil fiscal da empresa (o que ela vende)',
  })
  @ApiBody({ schema: schema(CreateProductSchema) })
  async createProduct(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    const product = await this.c.products.create(
      tenant,
      parseInput(CreateProductSchema, body),
      'APP'
    );
    await this.c.sales.resumeHeld(tenant.id);
    return toProductView(product);
  }

  @Post('companies/:tenantId/products/:productId/confirm-tax')
  @ApiOperation({
    summary: 'Usuário confirma a tributação sugerida (ou informada) e libera o produto para venda',
  })
  @ApiBody({ schema: schema(AppConfirmTaxSchema) })
  async confirmTax(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    const input = parseInput(AppConfirmTaxSchema, body);
    const current = await this.c.products.get(tenant.id, productId);
    const taxProfile = input.taxProfile ?? current.suggestedTaxProfile;
    if (!taxProfile) {
      throw DomainError.validation(
        'Este produto não tem sugestão de tributação: informe o taxProfile'
      );
    }
    const product = await this.c.products.confirmTax(tenant, productId, taxProfile, {
      userConfirmed: input.userConfirmed,
      note: input.note,
      via: 'APP',
    });
    return {
      product: toProductView(product),
      releasedHeldSales: await this.c.sales.resumeHeld(tenant.id),
    };
  }

  @Get('fiscal-profiles')
  @ApiOperation({ summary: 'Perfis fiscais padrão (resposta da pergunta "O que você vende?")' })
  fiscalProfiles() {
    return Object.values(FISCAL_PROFILES).map((p) => ({
      businessType: p.businessType,
      label: p.label,
      examples: p.examples,
      validated: p.validated,
      validationNote: p.validationNote,
      taxProfile: p.taxProfile,
    }));
  }
}
