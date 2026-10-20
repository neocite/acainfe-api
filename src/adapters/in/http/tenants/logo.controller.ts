import '@fastify/multipart';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { LogoSchema } from '../../schemas.js';
import { readMultipart } from '../shared/multipart.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';
import type { AuthedRequest } from '../shared/support.js';

@ApiTags('empresas')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/tenants/me/logo')
export class LogoController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Put()
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOperation({
    summary:
      'Define o logo exibido no PDF da nota: multipart "file" ou JSON {imageBase64 | imageUrl}',
  })
  async set(@CurrentTenant() tenant: Tenant, @Req() req: AuthedRequest) {
    if (req.isMultipart()) {
      const { file } = await readMultipart(req);
      return this.c.tenants.setLogo(tenant.id, { data: file });
    }
    const input = parseInput(LogoSchema, req.body);
    return this.c.tenants.setLogo(tenant.id, {
      data: input.imageBase64
        ? Buffer.from(input.imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
        : undefined,
      url: input.imageUrl,
    });
  }

  @Get()
  async get(@CurrentTenant() tenant: Tenant, @Res() reply: FastifyReply) {
    const logo = await this.c.tenants.getLogo(tenant.id);
    if (!logo) throw DomainError.notFound('Logo', tenant.id);
    return reply.header('Content-Type', logo.contentType).send(logo.data);
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: Tenant) {
    await this.c.tenants.removeLogo(tenant.id);
  }
}
