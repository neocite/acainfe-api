import { Controller, Headers, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { verifyAbacatePaySignature } from '../../webhooks/abacatepay.service.js';
import { CONTAINER } from '../shared/support.js';
import type { AuthedRequest } from '../shared/support.js';

@ApiTags('webhooks')
@Controller('v1/webhooks/billing')
export class BillingWebhookController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  /** Conta AbacatePay do açaínfe: confirma o pagamento do Pix de cobrança. */
  @Post('abacatepay')
  @HttpCode(200)
  async abacatepay(
    @Query('webhookSecret') secret: string | undefined,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Req() req: AuthedRequest
  ) {
    const expected = this.c.env.BILLING_ABACATEPAY_WEBHOOK_SECRET;
    const given = Buffer.from(secret ?? '');
    if (
      !expected ||
      given.length !== Buffer.byteLength(expected) ||
      !timingSafeEqual(given, Buffer.from(expected))
    ) {
      throw new DomainError('UNAUTHORIZED', 'webhookSecret inválido');
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    if (signature && !verifyAbacatePaySignature(raw, signature)) {
      throw new DomainError('UNAUTHORIZED', 'Assinatura X-Webhook-Signature inválida');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (req.body ?? {}) as Record<string, any>;
    if (body.event !== 'transparent.completed') return { status: 'IGNORED' };
    const charge = body.data?.transparent;
    if (!charge?.id) return { status: 'IGNORED' };
    const payment = await this.c.billing.confirmPayment(
      String(charge.id),
      Number(charge.paidAmount ?? charge.amount)
    );
    return payment
      ? { status: 'PAID', paymentId: payment.id }
      : { status: 'IGNORED', reason: 'Pagamento desconhecido' };
  }
}
