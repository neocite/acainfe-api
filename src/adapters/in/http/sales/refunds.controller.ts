import { Body, Controller, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { RefundSaleSchema } from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

@ApiTags('vendas')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/sales')
export class RefundsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post(':id/refund')
  @ApiOperation({
    summary:
      'Estorno: cancela na prefeitura as NFS-e emitidas da venda e impede a emissão das pendentes. Idempotente.',
  })
  @ApiBody({ schema: schema(RefundSaleSchema) })
  refund(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(RefundSaleSchema, body);
    return this.c.refunds.refundSale(tenant, { saleId: id }, { ...input, requestedBy: 'API' });
  }

  @Post('by-external-id/:externalId/refund')
  @ApiOperation({
    summary: 'Estorno pelo id da venda na origem (?source=API|MCP|ABACATEPAY, padrão API)',
  })
  @ApiBody({ schema: schema(RefundSaleSchema) })
  refundByExternalId(
    @CurrentTenant() tenant: Tenant,
    @Param('externalId') externalId: string,
    @Query('source') source: string | undefined,
    @Body() body: unknown
  ) {
    const input = parseInput(RefundSaleSchema, body);
    const origin = parseInput(
      z.object({ source: z.enum(['API', 'MCP', 'ABACATEPAY', 'ACAINFE_BILLING']).default('API') }),
      { source }
    ).source;
    return this.c.refunds.refundSale(
      tenant,
      { externalId, source: origin },
      { ...input, requestedBy: 'API' }
    );
  }
}
