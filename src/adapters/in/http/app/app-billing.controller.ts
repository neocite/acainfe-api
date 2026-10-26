import { Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { toPaymentView } from '../billing/payment-view.js';
import { AppHeaders, AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('app (onboarding)')
@AppHeaders()
@UseGuards(AppUserGuard)
@Controller('v1/app')
export class AppBillingController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('companies/:tenantId/billing')
  @ApiOperation({ summary: 'Saldo em aberto da empresa e data de pausa da emissão' })
  async billing(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.billing.summary(tenant.id);
  }

  @Post('companies/:tenantId/billing/payments')
  @ApiOperation({ summary: 'Gera o Pix (copia e cola + QR Code) para pagar o saldo em aberto' })
  async pay(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return toPaymentView(await this.c.billing.createPayment(tenant));
  }

  @Get('companies/:tenantId/billing/payments/:paymentId')
  @ApiOperation({
    summary:
      'Situação de um Pix de cobrança: PENDING, PAID (confirmado pelo gateway), EXPIRED. Para acompanhar até o pagamento',
  })
  async payment(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Param('paymentId') paymentId: string
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return toPaymentView(await this.c.billing.getPayment(tenant.id, paymentId));
  }
}
