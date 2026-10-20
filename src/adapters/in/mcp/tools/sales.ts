import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { toInvoiceView } from '../../presenters.js';
import { RefundSaleSchema } from '../../schemas.js';
import { readOnly, run } from '../tool-support.js';

/** Vendas e estorno. */
export function registerSaleTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'get_sale',
    {
      title: 'Detalhar venda',
      description: 'Venda com suas notas (uma por tributação) e situação de estorno',
      inputSchema: z.object({ id: z.string() }),
      annotations: readOnly,
    },
    ({ id }) =>
      run(async () => {
        const r = await c.sales.get(tenant.id, id);
        const { rawPayload: _raw, ...sale } = r.sale;
        return { sale, invoices: r.invoices.map((i) => toInvoiceView(i, c.links)) };
      })
  );

  server.registerTool(
    'refund_sale',
    {
      title: 'Estornar venda (cancelar notas)',
      description:
        'Estorno: cancela na prefeitura todas as NFS-e emitidas da venda e impede a emissão das pendentes. Informe saleId ou externalId (+source). Irreversível — confirme com o usuário.',
      inputSchema: RefundSaleSchema.extend({
        saleId: z.string().optional(),
        externalId: z.string().optional(),
        source: z
          .enum(['API', 'MCP', 'ABACATEPAY'])
          .optional()
          .describe('Origem da venda quando usar externalId (padrão MCP)'),
      }),
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ saleId, externalId, source, reasonCode, reason }) =>
      run(async () => {
        if (!saleId && !externalId) throw DomainError.validation('Informe saleId ou externalId');
        const result = await c.refunds.refundSale(
          tenant,
          { saleId, externalId, source: source ?? 'MCP' },
          { reasonCode, reason, requestedBy: 'MCP' }
        );
        return { saleId: result.sale.id, refund: result.sale.refund, invoices: result.invoices };
      })
  );
}
