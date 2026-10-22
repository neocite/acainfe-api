import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { toInvoiceView } from '../../presenters.js';
import { competenceToDate, CreateSaleSchema } from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

@ApiTags('vendas')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/sales')
export class SalesController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Registra uma venda e agenda a emissão (assíncrona). Itens com tributações diferentes geram notas diferentes.',
  })
  @ApiBody({ schema: schema(CreateSaleSchema) })
  async create(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    const input = parseInput(CreateSaleSchema, body);
    const result = await this.c.sales.register(tenant, {
      ...input,
      competenceDate: competenceToDate(input.competenceDate),
      source: 'API',
      rawPayload: body,
    });
    return { ...result, invoices: result.invoices.map((i) => toInvoiceView(i, this.c.links)) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Uma venda com as notas geradas (uma por tributação) e a situação de estorno',
  })
  async get(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    const result = await this.c.sales.get(tenant.id, id);
    return {
      sale: result.sale,
      invoices: result.invoices.map((i) => toInvoiceView(i, this.c.links)),
    };
  }
}
