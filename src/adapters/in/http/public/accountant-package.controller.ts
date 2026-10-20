import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { PERIOD_RE } from '../accountant/period.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('público')
@Controller('v1/public/accountant-packages')
export class PublicAccountantPackageController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get(':tenantId/:period')
  @ApiOperation({
    summary: 'Download do pacote mensal pelo contador (link assinado enviado por e-mail/WhatsApp)',
  })
  async download(
    @Param('tenantId') tenantId: string,
    @Param('period') period: string,
    @Query('sig') sig: string,
    @Res() reply: FastifyReply
  ) {
    if (!PERIOD_RE.test(period) || !this.c.links.verifyAccountantPackage(tenantId, period, sig)) {
      throw DomainError.notFound('Pacote', `${tenantId}/${period}`);
    }
    const tenant = await this.c.tenants.get(tenantId);
    const pkg = await this.c.accountant.buildPackage(tenant, period);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${pkg.zipName}"`)
      .send(pkg.zip);
  }
}
