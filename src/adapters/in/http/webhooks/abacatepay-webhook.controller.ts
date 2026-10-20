import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { CONTAINER } from '../shared/support.js';
import type { AuthedRequest } from '../shared/support.js';

@ApiTags('webhooks')
@Controller('v1/webhooks')
export class AbacatePayWebhookController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('abacatepay/:tenantId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe pagamentos confirmados do AbacatePay e emite as notas' })
  async abacatepay(
    @Param('tenantId') tenantId: string,
    @Query('webhookSecret') webhookSecret: string | undefined,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Req() req: AuthedRequest,
    @Res() reply: FastifyReply
  ) {
    const result = await this.c.abacatepay.handle({
      tenantId,
      webhookSecret,
      signature,
      rawBody: req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})),
      payload: (req.body ?? {}) as Record<string, unknown>,
    });
    return reply.status(200).send(
      result.status !== 'ACCEPTED'
        ? result
        : {
            status: result.status,
            saleId: result.result.sale.id,
            invoiceIds: result.result.invoices.map((i) => i.id),
          }
    );
  }
}
