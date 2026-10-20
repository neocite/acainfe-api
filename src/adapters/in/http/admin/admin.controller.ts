import { Body, Controller, Get, Inject, Param, Patch, Put, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { AdminTenantSchema } from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import { AdminGuard, CONTAINER, parseInput } from '../shared/support.js';

const CoverageSchema = z.object({
  cityName: z.string().optional(),
  uf: z.string().length(2).optional(),
  simples: z.boolean().describe('Libera Simples Nacional/MEI'),
  others: z.boolean().describe('Libera Lucro Presumido/Real'),
});

@ApiTags('admin')
@ApiHeader({ name: 'x-admin-key', required: true })
@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('coverage')
  coverage() {
    return this.c.onboarding.listCoverage();
  }

  @Put('coverage/:cityCode')
  @ApiOperation({
    summary:
      'Libera/bloqueia município por regime; ativa e avisa (e-mail/WhatsApp) quem estava na espera',
  })
  @ApiBody({ schema: schema(CoverageSchema) })
  setCoverage(@Param('cityCode') cityCode: string, @Body() body: unknown) {
    return this.c.onboarding.setCoverage({ cityCode, ...parseInput(CoverageSchema, body) });
  }

  @Get('waitlist')
  @ApiOperation({ summary: 'Lista de espera agrupada por município (para priorizar integrações)' })
  waitlist() {
    return this.c.onboarding.waitlistSummary();
  }

  @Patch('tenants/:tenantId')
  @ApiOperation({
    summary:
      'Controles internos da empresa: ambiente (produção/homologação) e sistema de emissão forçado',
  })
  @ApiBody({ schema: schema(AdminTenantSchema) })
  async updateTenant(@Param('tenantId') tenantId: string, @Body() body: unknown) {
    const input = parseInput(AdminTenantSchema, body);
    return this.c.tenants.update(tenantId, {
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.fiscalProvider !== undefined
        ? { fiscalProvider: input.fiscalProvider ?? undefined }
        : {}),
    });
  }
}
