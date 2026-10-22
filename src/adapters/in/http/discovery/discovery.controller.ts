import { Controller, Get, Header, Inject, NotFoundException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Container } from '../../../../config/container.js';
import { getPublicOpenApi } from '../shared/public-docs.js';
import { CONTAINER } from '../shared/support.js';

/** Descoberta por agentes: contrato OpenAPI público e cartão do servidor MCP. */
@ApiExcludeController()
@Controller()
export class DiscoveryController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('openapi.json')
  @Header('Cache-Control', 'public, max-age=3600')
  openapi() {
    const document = getPublicOpenApi();
    if (!document) throw new NotFoundException();
    return document;
  }

  /**
   * Cartão do servidor MCP (formato em discussão na comunidade MCP; não há manifesto ratificado):
   * onde fica, qual transporte e como autenticar. Nenhum segredo aqui.
   */
  @Get('.well-known/mcp.json')
  @Header('Cache-Control', 'public, max-age=3600')
  mcpServerCard() {
    const base = (this.c.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    return {
      name: 'acainfe',
      title: 'açaínfe',
      version: this.c.env.APP_VERSION,
      description:
        'Emissor de NFS-e brasileiro operável por agentes de IA: emite, consulta, reenvia e cancela notas, define a tributação de cada produto e conecta vendas do AbacatePay.',
      documentationUrl: 'https://acainfe.com/developers',
      instructionsUrl: 'https://acainfe.com/llms.txt',
      transport: { type: 'streamable-http', url: `${base}/mcp` },
      authentication: {
        required: true,
        schemes: ['bearer'],
        header: 'Authorization: Bearer <chave>',
        obtainKey: 'https://acainfe.com (menu "Agentes de IA")',
      },
      openapi: `${base}/openapi.json`,
    };
  }
}
