import { Body, Controller, Inject, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { AccountantSchema } from '../../schemas.js';
import { AppHeaders, AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import { schema } from '../shared/openapi.js';
import { CONTAINER, parseInput } from '../shared/support.js';

@ApiTags('app (onboarding)')
@AppHeaders()
@UseGuards(AppUserGuard)
@Controller('v1/app')
export class AppAccountantController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Put('companies/:tenantId/accountant')
  @ApiOperation({
    summary:
      'Contador: recebe automaticamente todo mês os PDFs, XMLs e a planilha das notas (e-mail e/ou WhatsApp)',
  })
  @ApiBody({ schema: schema(AccountantSchema) })
  async setAccountant(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.accountant.setAccountant(tenant.id, parseInput(AccountantSchema, body));
  }
}
