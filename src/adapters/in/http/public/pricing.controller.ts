import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import { CONTAINER } from '../shared/support.js';

@ApiTags('público')
@Controller('v1/public')
export class PublicPricingController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('pricing')
  @ApiOperation({ summary: 'Preço vigente por nota (a landing page lê daqui)' })
  pricing() {
    return {
      pricePerInvoiceCents: this.c.env.BILLING_PRICE_PER_INVOICE_CENTS,
      currency: 'BRL',
      monthlyFeeCents: 0,
      graceDays: this.c.env.BILLING_GRACE_DAYS,
    };
  }
}
