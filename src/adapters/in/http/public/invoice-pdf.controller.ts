import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('público')
@Controller('v1/public')
export class PublicInvoicePdfController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('invoices/:id/pdf')
  @ApiOperation({ summary: 'Download do DANFSe pelo tomador via link assinado' })
  async pdf(@Param('id') id: string, @Query('sig') sig: string, @Res() reply: FastifyReply) {
    if (!this.c.links.verify(id, sig)) throw DomainError.notFound('Nota', id);
    const invoice = await this.c.invoices.getInternal(id);
    const tenant = await this.c.tenants.get(invoice.tenantId);
    const pdf = await this.c.invoices.pdf(tenant, id);
    return reply.header('Content-Type', 'application/pdf').send(pdf);
  }
}
