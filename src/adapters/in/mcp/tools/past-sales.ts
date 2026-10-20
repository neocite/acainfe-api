import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import {
  PastSalesApplyReconciliationSchema,
  PastSalesIssueSchema,
  PastSalesMarkSchema,
  PastSalesReconcileSchema,
  PastSalesScanSchema,
} from '../../schemas.js';
import { readOnly, run } from '../tool-support.js';

/** Vendas pagas antes do açaínfe: busca, cruzamento com a prefeitura e emissão. */
export function registerPastSalesTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'scan_past_sales',
    {
      title: 'Buscar vendas sem nota',
      description:
        'Busca no AbacatePay as vendas pagas dos últimos meses que ainda não têm nota no açaínfe e mostra a prévia por mês (quantidade, total). Não emite nada.',
      inputSchema: PastSalesScanSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ monthsBack }) => run(() => c.pastSales.scan(tenant, monthsBack ?? 3))
  );

  server.registerTool(
    'list_past_sales',
    {
      title: 'Listar vendas passadas',
      description:
        'Prévia por mês (sem filtros) ou a lista de vendas de um mês/status para o usuário revisar e marcar as que já têm nota em outro sistema.',
      inputSchema: z.object({
        period: z.string().optional(),
        status: z.array(z.enum(['AVAILABLE', 'ALREADY_ISSUED', 'IMPORTED', 'REFUNDED'])).optional(),
      }),
      annotations: readOnly,
    },
    ({ period, status }) =>
      run(async () =>
        period || status
          ? { items: await c.pastSales.list(tenant, { period, status }) }
          : { periods: await c.pastSales.summary(tenant) }
      )
  );

  server.registerTool(
    'mark_past_sales_already_issued',
    {
      title: 'Marcar vendas que já têm nota',
      description:
        'Marca (ou desmarca) vendas passadas que JÁ têm nota emitida em outro sistema (ex.: eNotas), para não emitir em duplicidade. Pergunte ao usuário antes de emitir.',
      inputSchema: PastSalesMarkSchema,
    },
    (input) =>
      run(() =>
        c.pastSales.setAlreadyIssued(
          tenant,
          { ids: input.ids, period: input.period },
          input.alreadyIssued
        )
      )
  );

  server.registerTool(
    'reconcile_past_sales',
    {
      title: 'Cruzar vendas com as notas da prefeitura',
      description:
        'Antes de emitir vendas passadas: compara as vendas disponíveis do mês com as notas que a prefeitura já tem (ex.: emitidas pelo eNotas) e sugere quais já têm nota. Confiança HIGH = mesmo valor e CPF/CNPJ; MEDIUM = mesmo valor, nome e data próxima; LOW = só valor e data (só informativo). Não altera nada.',
      inputSchema: PastSalesReconcileSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ period }) => run(() => c.pastSales.reconcile(tenant, period))
  );

  server.registerTool(
    'apply_past_sales_reconciliation',
    {
      title: 'Marcar vendas que já têm nota (pelo cruzamento)',
      description:
        'Marca como "já emitida" as vendas que correspondem a notas da prefeitura no nível de confiança escolhido. Mostre antes a lista de reconcile_past_sales ao usuário e só aplique o que ele confirmar (use ids para limitar). Reversível com mark_past_sales_already_issued (alreadyIssued: false).',
      inputSchema: PastSalesApplyReconciliationSchema,
    },
    (input) => run(() => c.pastSales.applyReconciliation(tenant, input))
  );

  server.registerTool(
    'issue_past_sales',
    {
      title: 'Emitir notas de vendas passadas',
      description:
        'Emite as notas das vendas disponíveis de um mês. Para meses ANTERIORES ao atual, explique antes ao usuário: a nota sai com a competência do mês da venda e, no Simples, o contador pode precisar retificar o PGDAS (multa/juros) — só então envie confirmPastPeriod: true. Antes, rode reconcile_past_sales para não emitir em duplicidade (sem isso a emissão é recusada, a menos que o usuário aceite o risco com skipReconciliation: true).',
      inputSchema: PastSalesIssueSchema,
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    (input) => run(() => c.pastSales.issue(tenant, input))
  );
}
