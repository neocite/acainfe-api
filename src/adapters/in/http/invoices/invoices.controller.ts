import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { toInvoiceView } from '../../presenters.js';
import { CancelInvoiceSchema, ListInvoicesSchema, ResendInvoiceSchema } from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';

@ApiTags('notas')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/invoices')
export class InvoicesController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get()
  @ApiOperation({ summary: 'Lista notas, com filtros por status, período e CPF/CNPJ do tomador' })
  async list(@CurrentTenant() tenant: Tenant, @Query() query: Record<string, string>) {
    const page = await this.c.invoices.list(tenant.id, parseInput(ListInvoicesSchema, query));
    return { ...page, items: page.items.map((i) => toInvoiceView(i, this.c.links)) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Status, número, chave, link do PDF e histórico de uma nota' })
  async get(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return toInvoiceView(await this.c.invoices.get(tenant.id, id), this.c.links);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'PDF (DANFSe) da nota emitida' })
  async pdf(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() reply: FastifyReply) {
    const pdf = await this.c.invoices.pdf(tenant, id);
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="NFSe-${id}.pdf"`)
      .send(pdf);
  }

  @Get(':id/xml')
  @ApiOperation({ summary: 'XML da nota emitida, como gravado pela prefeitura ou pela Sefin' })
  async xml(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Res() reply: FastifyReply) {
    const invoice = await this.c.invoices.get(tenant.id, id);
    if (!invoice.nfse) throw DomainError.invalidState('A nota ainda não foi emitida');
    return reply.header('Content-Type', 'application/xml').send(invoice.nfse.xml);
  }

  @Get(':id/explain')
  @ApiOperation({ summary: 'Explica a rejeição da prefeitura e sugere a correção' })
  explain(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return this.c.invoices.explain(tenant.id, id);
  }

  @Post(':id/cancel')
  @ApiBody({ schema: schema(CancelInvoiceSchema) })
  @ApiOperation({ summary: 'Cancela uma NFS-e emitida (irreversível)' })
  async cancel(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(CancelInvoiceSchema, body);
    return toInvoiceView(
      await this.c.invoices.cancel(tenant, id, input.reasonCode, input.reason),
      this.c.links
    );
  }

  @Post(':id/retry')
  @HttpCode(202)
  @ApiOperation({ summary: 'Reprocessa uma nota rejeitada ou com falha' })
  async retry(@CurrentTenant() tenant: Tenant, @Param('id') id: string) {
    return toInvoiceView(await this.c.invoices.retry(tenant.id, id), this.c.links);
  }

  @Post(':id/resend')
  @HttpCode(202)
  @ApiBody({ schema: schema(ResendInvoiceSchema) })
  @ApiOperation({ summary: 'Reenvia a nota ao cliente por e-mail ou WhatsApp' })
  async resend(@CurrentTenant() tenant: Tenant, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(ResendInvoiceSchema, body);
    return toInvoiceView(
      await this.c.invoices.resend(tenant.id, id, input.channel, input.to),
      this.c.links
    );
  }
}
