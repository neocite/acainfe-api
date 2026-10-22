import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { CONTAINER } from '../shared/support.js';

const page = (title: string, text: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;line-height:1.5"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body></html>`;

/** Link "não quero mais receber" dos lembretes da régua de ativação (assinado por usuário). */
@ApiExcludeController()
@Controller('v1/public/activation')
export class PublicActivationController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('unsubscribe')
  async unsubscribe(
    @Query('u') userId: string,
    @Query('sig') signature: string,
    @Res() reply: FastifyReply
  ) {
    if (!userId || !this.c.links.verifyUnsubscribe(userId, signature)) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(page('Link inválido', 'Este link não é válido ou expirou.'));
    }
    await this.c.activation.unsubscribe(userId);
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Pronto, sem mais lembretes',
          'Você não vai mais receber lembretes do cadastro do açaínfe. Avisos das suas notas e da sua conta continuam chegando normalmente.'
        )
      );
  }
}
