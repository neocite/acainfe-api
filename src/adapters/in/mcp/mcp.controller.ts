import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../../config/container.js';
import { DomainError } from '../../../domain/shared/domain-error.js';
import { CONTAINER, extractApiKey } from '../http/shared/support.js';
import { buildMcpServer } from './mcp-server.js';

/**
 * Endpoint MCP (Streamable HTTP, spec 2026-07-28 com fallback stateless para clientes 2025).
 * Autenticação: mesma API key da REST em `Authorization: Bearer <key>` ou `x-api-key`.
 */
@ApiExcludeController()
@Controller('mcp')
export class McpController {
  private readonly handle: ReturnType<typeof toNodeHandler>;

  constructor(@Inject(CONTAINER) private readonly c: Container) {
    const handler = createMcpHandler(async (ctx) => {
      const tenantId = ctx.authInfo?.clientId;
      const tenant = tenantId ? await this.c.tenants.get(tenantId) : undefined;
      if (!tenant) throw new DomainError('UNAUTHORIZED', 'Não autenticado');
      return buildMcpServer(this.c, tenant);
    });
    this.handle = toNodeHandler(handler, {
      onerror: (e) => this.c.logger.error('Erro MCP', { error: e.message }),
    });
  }

  @All()
  async mcp(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    let tenantId: string;
    try {
      tenantId = (await this.c.tenants.authenticate(extractApiKey(req.headers))).id;
    } catch {
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="acainfe"')
        .send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'API key inválida ou ausente' },
          id: null,
        });
    }
    reply.hijack();
    const raw = req.raw as typeof req.raw & {
      auth?: { token: string; clientId: string; scopes: string[] };
    };
    raw.auth = { token: 'api-key', clientId: tenantId, scopes: ['nfse'] };
    await this.handle(raw, reply.raw, req.body);
  }
}
