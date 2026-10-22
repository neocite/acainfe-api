import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { toProductView } from '../../presenters.js';
import { CreateProductSchema, UpdateProductSchema } from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

@ApiTags('produtos')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class ProductsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('products')
  @ApiOperation({
    summary:
      'Cadastra produto/serviço com sua própria tributação (código de serviço, alíquota, retenções)',
  })
  @ApiBody({ schema: schema(CreateProductSchema) })
  async create(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    const product = await this.c.products.create(tenant, parseInput(CreateProductSchema, body));
    // Libera vendas que estavam retidas aguardando este produto.
    await this.c.sales.resumeHeld(tenant.id);
    return toProductView(product);
  }

  @Get('products')
  @ApiOperation({ summary: 'Lista os produtos/serviços e a tributação de cada um' })
  async list(@CurrentTenant() tenant: Tenant, @Query() query: Record<string, string>) {
    const q = parseInput(
      z.object({
        search: z.string().optional(),
        includeInactive: z.enum(['true', 'false']).optional(),
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().positive().max(100).optional(),
      }),
      query
    );
    const page = await this.c.products.list(tenant.id, {
      ...q,
      includeInactive: q.includeInactive === 'true',
    });
    return { ...page, items: page.items.map(toProductView) };
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Um produto e a tributação dele' })
  async get(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return toProductView(await this.c.products.get(tenant.id, id));
  }

  @Patch('products/:id')
  @ApiBody({ schema: schema(UpdateProductSchema) })
  @ApiOperation({ summary: 'Atualiza nome, descrição, preço ou tributação de um produto' })
  async update(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown) {
    const product = await this.c.products.update(tenant, id, parseInput(UpdateProductSchema, body));
    await this.c.sales.resumeHeld(tenant.id);
    return toProductView(product);
  }

  @Delete('products/:id')
  @ApiOperation({ summary: 'Desativa um produto (novas vendas com ele são recusadas)' })
  deactivate(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return this.c.products.deactivate(tenant.id, id);
  }

  @Get('service-codes')
  @ApiOperation({ summary: 'Busca códigos de tributação nacional (cTribNac) por texto' })
  serviceCodes(@Query('q') q = '', @Query('limit') limit?: string) {
    return this.c.products.searchServiceCodes(q, Math.min(Number(limit) || 20, 50));
  }

  @Get('municipal-params/:nationalServiceCode')
  @ApiOperation({
    summary:
      'Alíquota parametrizada pelo município para o código (consulta ADN com o certificado da empresa)',
  })
  municipalParams(@CurrentTenant() tenant: Tenant, @Param('nationalServiceCode') code: string) {
    return this.c.products.municipalParams(tenant, code);
  }
}
