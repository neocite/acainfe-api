import { Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { toPaymentView } from './payment-view.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

const pageQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

@ApiTags('cobrança')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/billing')
export class BillingController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get()
  @ApiOperation({ summary: 'Saldo em aberto, valor a pagar e data em que a emissão será pausada' })
  summary(@CurrentTenant() tenant: Tenant) {
    return this.c.billing.summary(tenant.id);
  }

  @Get('charges')
  @ApiOperation({ summary: 'Extrato: uma cobrança por nota emitida' })
  charges(@CurrentTenant() tenant: Tenant, @Query() query: Record<string, string>) {
    return this.c.billing.listCharges(tenant.id, parseInput(pageQuery, query));
  }

  @Post('payments')
  @ApiOperation({ summary: 'Gera (ou reaproveita) o Pix para pagar o saldo em aberto' })
  async pay(@CurrentTenant() tenant: Tenant) {
    return toPaymentView(await this.c.billing.createPayment(tenant));
  }

  @Get('payments/:id')
  @ApiOperation({
    summary: 'Situação de um Pix de cobrança: PENDING, PAID (confirmado pelo gateway) ou EXPIRED',
  })
  async payment(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return toPaymentView(await this.c.billing.getPayment(tenant.id, id));
  }
}
