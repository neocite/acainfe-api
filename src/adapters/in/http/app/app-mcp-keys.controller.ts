import { Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { AppHeaders, AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import { schema } from '../shared/openapi.js';
import { CONTAINER, parseInput } from '../shared/support.js';

const IssueKeySchema = z.object({
  label: z
    .string()
    .max(60)
    .optional()
    .describe('Nome para reconhecer a chave depois (ex.: "Claude Code do notebook")'),
});

/** Chaves do MCP/API da empresa: gerar, listar e revogar (ex.: chave vazada). */
@ApiTags('app (onboarding)')
@AppHeaders()
@UseGuards(AppUserGuard)
@Controller('v1/app/companies/:tenantId')
export class AppMcpKeysController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('mcp-key')
  @ApiOperation({
    summary: 'Gera uma chave do MCP (exibida uma única vez) e o comando para conectar',
  })
  @ApiBody({ schema: schema(IssueKeySchema), required: false })
  async issue(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.onboarding.issueMcpKey(tenant, parseInput(IssueKeySchema, body).label);
  }

  @Get('mcp-keys')
  @ApiOperation({
    summary: 'Chaves ativas (sem o segredo): nome, final, criação e último uso',
  })
  async list(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return { items: await this.c.tenants.listApiKeys(tenant.id) };
  }

  @Delete('mcp-keys/:keyId')
  @ApiOperation({ summary: 'Revoga uma chave: ela para de funcionar na hora' })
  async revoke(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Param('keyId') keyId: string
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.tenants.revokeApiKey(tenant.id, keyId);
  }

  @Delete('mcp-keys')
  @ApiOperation({
    summary: 'Revoga todas as chaves (suspeita de vazamento). Gere uma nova para voltar a usar',
  })
  async revokeAll(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.tenants.revokeAllApiKeys(tenant.id);
  }
}
