import '@fastify/multipart';
import { Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant, parseInput } from '../shared/support.js';
import type { AuthedRequest } from '../shared/support.js';

@ApiTags('certificados')
@ApiSecurity('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1/certificates')
export class CertificatesController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @ApiOperation({
    summary:
      'Envia o certificado A1 (.pfx). multipart/form-data com campos "file" e "password", ou JSON {pfxBase64, password}',
  })
  async upload(@CurrentTenant() tenant: Tenant, @Req() req: AuthedRequest) {
    let pfx: Buffer | undefined;
    let password: string | undefined;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') pfx = await part.toBuffer();
        else if (part.fieldname === 'password') password = String(part.value);
      }
    } else {
      const body = parseInput(
        z.object({ pfxBase64: z.string().min(1), password: z.string() }),
        req.body
      );
      pfx = Buffer.from(body.pfxBase64, 'base64');
      password = body.password;
    }
    if (!pfx || password === undefined)
      throw DomainError.validation('Envie o arquivo .pfx e a senha');
    return this.c.certificates.upload(tenant, pfx, password);
  }

  @Get('current')
  current(@CurrentTenant() tenant: Tenant) {
    return this.c.certificates.status(tenant.id);
  }
}
