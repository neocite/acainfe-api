import { Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { AppHeaders, AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import { CONTAINER } from '../shared/support.js';

/** Ficha fiscal da empresa: tudo o que define as notas, para conferir com o contador. */
@ApiTags('app (onboarding)')
@AppHeaders()
@UseGuards(AppUserGuard)
@Controller('v1/app/companies/:tenantId/fiscal-settings')
export class AppFiscalSettingsController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get()
  @ApiOperation({
    summary:
      'Ficha fiscal: empresa, emissão, tributação padrão, ISS, IBPT, certificado, contador e produtos (com resumo em texto)',
  })
  async get(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    return this.c.fiscalSettings.get(await this.c.accounts.ownedTenant(user, tenantId));
  }

  @Post('send')
  @ApiOperation({ summary: 'Envia a ficha fiscal ao contador cadastrado (e-mail e/ou WhatsApp)' })
  async send(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return { sentTo: await this.c.fiscalSettings.sendToAccountant(tenant) };
  }
}
