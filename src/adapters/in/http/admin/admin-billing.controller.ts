import { Body, Controller, Get, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { schema } from '../shared/openapi.js';
import { AdminGuard, CONTAINER, parseInput } from '../shared/support.js';

const ManualPaymentSchema = z.object({ amountCents: z.number().int().positive() });

const PriceSchema = z.object({ pricePerInvoiceCents: z.number().int().min(0).nullable() });

@ApiTags('admin')
@ApiHeader({ name: 'x-admin-key', required: true })
@UseGuards(AdminGuard)
@Controller('v1/admin/billing')
export class AdminBillingController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get()
  @ApiOperation({ summary: 'Contas de cobrança (?status=BLOCKED para as com emissão pausada)' })
  async list(@Query('status') status?: string) {
    const parsed = parseInput(z.object({ status: z.enum(['OK', 'BLOCKED']).optional() }), {
      status,
    });
    const accounts = await this.c.billing.listAccounts(parsed.status);
    return Promise.all(
      accounts.map(async (a) => ({ ...a, summary: await this.c.billing.summary(a.tenantId) }))
    );
  }

  @Get(':tenantId')
  summary(@Param('tenantId') tenantId: string) {
    return this.c.billing.summary(tenantId);
  }

  @Post(':tenantId/manual-payment')
  @ApiOperation({
    summary: 'Registra pagamento recebido fora do Pix gerado (quita as cobranças mais antigas)',
  })
  @ApiBody({ schema: schema(ManualPaymentSchema) })
  manual(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.c.billing.recordManualPayment(
      tenantId,
      parseInput(ManualPaymentSchema, body).amountCents
    );
  }

  @Put(':tenantId/price')
  @ApiOperation({ summary: 'Preço negociado por nota para a empresa (null volta ao preço padrão)' })
  @ApiBody({ schema: schema(PriceSchema) })
  price(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    return this.c.billing.setPrice(tenantId, parseInput(PriceSchema, body).pricePerInvoiceCents);
  }
}
