import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { previousPeriod } from '../../../../domain/accounting/accountant-report.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { AccountantReportRequestSchema, AccountantSchema } from '../../schemas.js';
import { PERIOD_RE } from './period.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

@ApiTags('contador')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/tenants/me/accountant')
export class AccountantController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Put()
  @ApiOperation({
    summary:
      'Cadastra o contador: recebe todo mês PDFs, XMLs e planilha das notas por e-mail/WhatsApp',
  })
  @ApiBody({ schema: schema(AccountantSchema) })
  set(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.c.accountant.setAccountant(tenant.id, parseInput(AccountantSchema, body));
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: Tenant) {
    await this.c.accountant.setAccountant(tenant.id, null);
  }

  @Get('reports')
  @ApiOperation({ summary: 'Histórico de envios ao contador' })
  reports(@CurrentTenant() tenant: Tenant) {
    return this.c.accountant.history(tenant.id);
  }

  @Post('reports')
  @ApiOperation({ summary: 'Envia agora o pacote de um mês ao contador (padrão: mês anterior)' })
  @ApiBody({ schema: schema(AccountantReportRequestSchema) })
  send(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    const { period } = parseInput(AccountantReportRequestSchema, body);
    return this.c.accountant.send(tenant, period ?? previousPeriod(new Date()), 'MANUAL');
  }

  @Get('packages/:period')
  @ApiOperation({ summary: 'Baixa o ZIP do mês (PDFs + XMLs + planilha)' })
  async download(
    @CurrentTenant() tenant: Tenant,
    @Param('period') period: string,
    @Res() reply: FastifyReply
  ) {
    if (!PERIOD_RE.test(period))
      throw DomainError.validation('period deve estar no formato AAAA-MM');
    const pkg = await this.c.accountant.buildPackage(tenant, period);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${pkg.zipName}"`)
      .send(pkg.zip);
  }
}
