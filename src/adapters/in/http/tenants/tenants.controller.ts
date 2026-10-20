import { Body, Controller, Get, Inject, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { toTenantView } from '../../../../application/use-cases/tenant.service.js';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { toConnectAbacatePayView } from '../../presenters.js';
import {
  ConnectAbacatePaySchema,
  CreateTenantSchema,
  NumberingSchema,
  UpdateTenantSchema,
} from '../../schemas.js';
import { schema } from '../shared/openapi.js';
import {
  AdminGuard,
  ApiKeyGuard,
  CONTAINER,
  CurrentTenant,
  parseInput,
} from '../shared/support.js';

@ApiTags('empresas')
@Controller('v1/tenants')
export class TenantsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post()
  @UseGuards(AdminGuard)
  @ApiHeader({ name: 'x-admin-key', required: true })
  @ApiOperation({
    summary: 'Cadastra uma empresa emissora e devolve sua API key (exibida uma única vez)',
  })
  @ApiBody({ schema: schema(CreateTenantSchema) })
  create(@Body() body: unknown) {
    return this.c.tenants.create(parseInput(CreateTenantSchema, body));
  }

  @Get('me')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('apiKey')
  me(@CurrentTenant() tenant: Tenant) {
    return toTenantView(tenant);
  }

  @Patch('me')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('apiKey')
  @ApiBody({ schema: schema(UpdateTenantSchema) })
  update(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.c.tenants.update(tenant.id, parseInput(UpdateTenantSchema, body));
  }

  @Post('me/api-key/rotate')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('apiKey')
  @ApiOperation({ summary: 'Gera nova API key e invalida a anterior' })
  rotate(@CurrentTenant() tenant: Tenant) {
    return this.c.tenants.rotateApiKey(tenant.id);
  }

  @Put('me/numbering')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('apiKey')
  @ApiOperation({
    summary:
      'Série e próximo número das notas. Já emite por outro sistema? Use issuesElsewhere=true (série exclusiva 900) ou informe série/próximo número livres.',
  })
  @ApiBody({ schema: schema(NumberingSchema) })
  numbering(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    return this.c.tenants.setNumbering(tenant.id, parseInput(NumberingSchema, body));
  }

  @Post('me/integrations/abacatepay')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('apiKey')
  @ApiOperation({
    summary:
      'Conecta o AbacatePay. Com apiKey: cria o webhook, importa os produtos e busca os pagamentos antigos sem nota (prévia). Sem corpo: só devolve a URL do webhook para cadastrar manualmente',
  })
  @ApiBody({ schema: schema(ConnectAbacatePaySchema), required: false })
  async enableAbacatePay(@CurrentTenant() tenant: Tenant, @Body() body: unknown) {
    if (body && typeof body === 'object' && 'apiKey' in body) {
      const { apiKey, ...options } = parseInput(ConnectAbacatePaySchema, body);
      return toConnectAbacatePayView(
        await this.c.onboarding.connectAbacatePay(tenant, apiKey, options)
      );
    }
    if (!this.c.env.PUBLIC_BASE_URL)
      throw DomainError.validation('PUBLIC_BASE_URL não configurada no servidor');
    return this.c.tenants.enableAbacatePay(tenant.id, this.c.env.PUBLIC_BASE_URL);
  }
}
