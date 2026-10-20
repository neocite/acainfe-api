import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { toInvoiceView } from '../../presenters.js';
import {
  CancelInvoiceSchema,
  competenceToDate,
  CreateSaleSchema,
  ListInvoicesSchema,
  ResendInvoiceSchema,
} from '../../schemas.js';
import { idArg, readOnly, run } from '../tool-support.js';

/** Notas: emissão, consulta, modo piloto, consultas na prefeitura, cancelamento e reenvio. */
export function registerInvoiceTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'issue_invoice',
    {
      title: 'Emitir nota fiscal',
      description:
        'Registra uma venda e agenda a emissão da(s) NFS-e. Itens com códigos de serviço/alíquotas diferentes geram notas separadas. Idempotente por externalId. Valores em centavos.',
      inputSchema: CreateSaleSchema,
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      run(async () => {
        const result = await c.sales.register(tenant, {
          ...input,
          competenceDate: competenceToDate(input.competenceDate),
          source: 'MCP',
          rawPayload: input,
        });
        return {
          duplicated: result.duplicated,
          saleId: result.sale.id,
          invoices: result.invoices.map((i) => toInvoiceView(i, c.links)),
          note: 'Emissão assíncrona — consulte get_invoice para acompanhar o status.',
        };
      })
  );

  server.registerTool(
    'list_invoices',
    {
      title: 'Listar notas emitidas',
      description:
        'Lista notas com filtros por status (PENDING, PROCESSING, RETRYING, ISSUED, REJECTED, FAILED, CANCELLED), período e CPF/CNPJ do tomador',
      inputSchema: z.object({
        status: z.array(z.string()).optional(),
        from: z.string().optional().describe('ISO 8601'),
        to: z.string().optional().describe('ISO 8601'),
        customerTaxId: z.string().optional(),
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(100).optional(),
      }),
      annotations: readOnly,
    },
    (input) =>
      run(async () => {
        const filter = ListInvoicesSchema.parse(input);
        const page = await c.invoices.list(tenant.id, filter);
        return { ...page, items: page.items.map((i) => toInvoiceView(i, c.links)) };
      })
  );

  server.registerTool(
    'get_invoice',
    {
      title: 'Detalhar nota',
      description: 'Status, número, chave de acesso, link do PDF e histórico da nota',
      inputSchema: idArg,
      annotations: readOnly,
    },
    ({ id }) => run(async () => toInvoiceView(await c.invoices.get(tenant.id, id), c.links))
  );

  server.registerTool(
    'explain_invoice',
    {
      title: 'Explicar rejeição',
      description: 'Retorna os erros devolvidos pela prefeitura e sugestões de correção',
      inputSchema: idArg,
      annotations: readOnly,
    },
    ({ id }) => run(() => c.invoices.explain(tenant.id, id))
  );

  server.registerTool(
    'retry_invoice',
    {
      title: 'Reprocessar nota',
      description: 'Reenvia uma nota REJECTED/FAILED/RETRYING para emissão',
      inputSchema: idArg,
    },
    ({ id }) => run(async () => toInvoiceView(await c.invoices.retry(tenant.id, id), c.links))
  );

  server.registerTool(
    'preview_invoice',
    {
      title: 'Prévia da nota (modo piloto)',
      description:
        'Mostra o XML que será enviado à prefeitura (sem assinatura). Use no modo piloto (lastErrors AWAITING_APPROVAL): confira com o usuário prestador, tomador, valor, código de serviço e alíquota antes de approve_invoice.',
      inputSchema: idArg,
      annotations: readOnly,
    },
    ({ id }) => run(() => c.invoices.preview(tenant, id))
  );

  server.registerTool(
    'approve_invoice',
    {
      title: 'Aprovar envio da nota (modo piloto)',
      description:
        'Libera o envio de uma nota que aguarda aprovação (AWAITING_APPROVAL). A nota vira documento fiscal real na prefeitura: só chame depois que o usuário conferir a prévia (preview_invoice) e confirmar.',
      inputSchema: idArg,
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    ({ id }) => run(async () => toInvoiceView(await c.invoices.approve(tenant, id, 'MCP'), c.links))
  );

  server.registerTool(
    'list_municipal_invoices',
    {
      title: 'Notas na prefeitura',
      description:
        'Consulta direto na prefeitura as NFS-e emitidas pela empresa num período (inclusive por outros sistemas, como o eNotas). Não altera nada. Datas AAAA-MM-DD.',
      inputSchema: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ from, to }) =>
      run(async () => ({
        items: await c.invoices.listMunicipal(tenant, {
          from: new Date(`${from}T00:00:00-03:00`),
          to: new Date(`${to}T23:59:59-03:00`),
        }),
      }))
  );

  server.registerTool(
    'get_municipal_invoice',
    {
      title: 'Nota na prefeitura (por número)',
      description:
        'Traz uma NFS-e direto da prefeitura pelo número (inclusive emitida por outro sistema, como o eNotas), com os campos fiscais gravados (regime especial, alíquota, ISS, retenção, item, código, competência), o tomador e o XML. Informe a data de emissão (AAAA-MM-DD, veja em list_municipal_invoices): a consulta só pelo número pode não responder no Ginfes. Não altera nada.',
      inputSchema: z.object({
        number: z.string().regex(/^\d{1,15}$/),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Dia da emissão da nota (AAAA-MM-DD), horário de Brasília'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ number, date }) =>
      run(() =>
        c.invoices.getMunicipal(
          tenant,
          number,
          date ? new Date(`${date}T12:00:00-03:00`) : undefined
        )
      )
  );

  server.registerTool(
    'cancel_invoice',
    {
      title: 'Cancelar nota',
      description:
        'Cancela uma NFS-e emitida junto à Sefin. Ação irreversível — confirme com o usuário antes.',
      inputSchema: CancelInvoiceSchema.extend({ id: z.string() }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ id, reasonCode, reason }) =>
      run(async () =>
        toInvoiceView(await c.invoices.cancel(tenant, id, reasonCode, reason), c.links)
      )
  );

  server.registerTool(
    'resend_invoice',
    {
      title: 'Reenviar nota',
      description:
        'Reenvia o DANFSe ao tomador por e-mail ou WhatsApp (opcionalmente para outro destino)',
      inputSchema: ResendInvoiceSchema.extend({ id: z.string() }),
      annotations: { openWorldHint: true },
    },
    ({ id, channel, to }) =>
      run(async () => toInvoiceView(await c.invoices.resend(tenant.id, id, channel, to), c.links))
  );
}
