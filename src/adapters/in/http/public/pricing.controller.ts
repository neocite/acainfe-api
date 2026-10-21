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

  @Get('coverage')
  @ApiOperation({
    summary:
      'Cidades atendidas (a landing e a lista de espera leem daqui): regimes liberados em cada uma',
  })
  async coverage() {
    const cities = (await this.c.onboarding.listCoverage())
      .filter((c) => c.simples || c.others)
      .map((c) => ({
        cityCode: c.cityCode,
        cityName: c.cityName,
        uf: c.uf,
        // "simples" cobre MEI e Simples Nacional; "others", Lucro Presumido/Real.
        regimes: [
          ...(c.simples ? ['MEI', 'SIMPLES_NACIONAL'] : []),
          ...(c.others ? ['LUCRO_PRESUMIDO', 'LUCRO_REAL'] : []),
        ],
      }))
      .sort((a, b) => (a.cityName ?? '').localeCompare(b.cityName ?? ''));
    return { cities };
  }
}
