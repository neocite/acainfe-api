import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import {
  PastSalesApplyReconciliationSchema,
  PastSalesIssueSchema,
  PastSalesMarkSchema,
  PastSalesScanSchema,
} from '../../schemas.js';
import { PastSalesOps } from './past-sales.ops.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant } from '../shared/support.js';

@ApiTags('vendas passadas')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/past-sales')
export class PastSalesController {
  private readonly ops: PastSalesOps;
  constructor(@Inject(CONTAINER) c: Container) {
    this.ops = new PastSalesOps(c);
  }

  @Post('scan')
  @ApiOperation({
    summary:
      'Busca no AbacatePay as vendas pagas dos últimos meses e monta a prévia (não emite nada)',
  })
  @ApiBody({ schema: schema(PastSalesScanSchema) })
  scan(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.ops.scan(tenant, body);
  }

  @Get()
  @ApiOperation({
    summary: 'Prévia por mês: disponíveis, já emitidas em outro sistema, importadas, estornadas',
  })
  summary(@CurrentTenant() tenant: Tenant) {
    return this.ops.summary(tenant);
  }

  @Get('items')
  list(@CurrentTenant() tenant: Tenant, @Query() query: Record<string, string>) {
    return this.ops.list(tenant, query);
  }

  @Post('mark')
  @ApiOperation({
    summary: 'Marca/desmarca vendas que já têm nota em outro sistema (não serão emitidas)',
  })
  @ApiBody({ schema: schema(PastSalesMarkSchema) })
  mark(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.ops.mark(tenant, body);
  }

  @Post('issue')
  @ApiOperation({
    summary: 'Emite as vendas disponíveis de um mês (meses anteriores exigem confirmPastPeriod)',
  })
  @ApiBody({ schema: schema(PastSalesIssueSchema) })
  issue(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.ops.issue(tenant, body);
  }

  @Get('reconcile')
  @ApiOperation({
    summary:
      'Cruza as vendas do mês com as notas já emitidas na prefeitura (ex.: pelo eNotas). Só sugere',
  })
  reconcile(@CurrentTenant() tenant: Tenant, @Query() query: Record<string, string>) {
    return this.ops.reconcile(tenant, query);
  }

  @Post('reconcile/apply')
  @ApiOperation({
    summary: 'Marca como já emitidas as vendas que correspondem a notas da prefeitura',
  })
  @ApiBody({ schema: schema(PastSalesApplyReconciliationSchema) })
  applyReconciliation(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.ops.applyReconciliation(tenant, body);
  }
}
