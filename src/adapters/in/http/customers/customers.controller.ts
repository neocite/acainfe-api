import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { CustomerSchema, UpdateCustomerSchema } from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

@ApiTags('clientes')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/customers')
export class CustomersController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @ApiOperation({
    summary: 'Cadastra cliente (tomador). Vendas com dados novos também cadastram automaticamente.',
  })
  @ApiBody({ schema: schema(CustomerSchema) })
  create(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.c.customers.create(tenant.id, parseInput(CustomerSchema, body));
  }

  @Get()
  list(@CurrentTenant() tenant: Tenant, @Query() query: Record<string, string>) {
    const q = parseInput(
      z.object({
        search: z.string().optional(),
        page: z.coerce.number().int().positive().optional(),
        pageSize: z.coerce.number().int().positive().max(100).optional(),
      }),
      query
    );
    return this.c.customers.list(tenant.id, q);
  }

  @Get(':id')
  get(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return this.c.customers.get(tenant.id, id);
  }

  @Patch(':id')
  @ApiBody({ schema: schema(UpdateCustomerSchema) })
  update(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown) {
    return this.c.customers.update(tenant.id, id, parseInput(UpdateCustomerSchema, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    await this.c.customers.delete(tenant.id, id);
  }
}
