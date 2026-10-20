import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { toProductView } from '../../presenters.js';
import { CreateProductSchema, TaxProfileSchema, UpdateProductSchema } from '../../schemas.js';
import { productWarnings } from '../../../../domain/product/product.js';
import { readOnly, run } from '../tool-support.js';

/** Produtos e tributação (códigos de serviço, alíquota municipal, confirmação pelo usuário). */
export function registerProductTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'search_service_codes',
    {
      title: 'Buscar código de serviço',
      description:
        'Busca o código de tributação nacional (cTribNac, 6 dígitos) pela descrição do serviço. Ex.: "suporte informática", "consultoria"',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: readOnly,
    },
    ({ query, limit }) =>
      run(async () => ({ codes: c.products.searchServiceCodes(query, limit ?? 10) }))
  );

  server.registerTool(
    'get_municipal_rate',
    {
      title: 'Alíquota municipal do serviço',
      description:
        'Consulta na API nacional a alíquota de ISS parametrizada pelo município da empresa para o código de serviço',
      inputSchema: z.object({ nationalServiceCode: z.string() }),
      annotations: { ...readOnly, openWorldHint: true },
    },
    ({ nationalServiceCode }) => run(() => c.products.municipalParams(tenant, nationalServiceCode))
  );

  server.registerTool(
    'create_product',
    {
      title: 'Cadastrar produto/serviço',
      description:
        'Cadastra um serviço com sua tributação própria (código de serviço, alíquota, retenções). Pode ter externalId para casar com o gateway de pagamento.',
      inputSchema: CreateProductSchema,
    },
    (input) =>
      run(async () => {
        const product = await c.products.create(tenant, input, 'MCP');
        return {
          ...toProductView(product),
          releasedHeldSales: await c.sales.resumeHeld(tenant.id),
        };
      })
  );

  server.registerTool(
    'update_product',
    {
      title: 'Atualizar produto',
      description: 'Atualiza nome, descrição, preço ou tributação de um produto',
      inputSchema: UpdateProductSchema.extend({ id: z.string() }),
    },
    ({ id, ...patch }) =>
      run(async () => toProductView(await c.products.update(tenant, id, patch, 'MCP')))
  );

  server.registerTool(
    'list_pending_products',
    {
      title: 'Produtos aguardando tributação',
      description:
        'Produtos importados do gateway que ainda não podem ser vendidos porque falta definir o código de serviço. Use com get_company (CNAEs) para orientar o usuário.',
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const page = await c.products.list(tenant.id, { pendingTaxReview: true, pageSize: 100 });
        return {
          total: page.total,
          products: page.items.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.serviceDescription,
            externalId: p.externalId,
            defaultPriceCents: p.defaultPriceCents,
            suggestedTaxProfile: p.suggestedTaxProfile,
            warnings: productWarnings(p),
          })),
        };
      })
  );

  server.registerTool(
    'confirm_product_tax',
    {
      title: 'Confirmar tributação do produto',
      description:
        'Define o código de serviço/alíquota de um produto e o libera para venda. Só chame depois que o USUÁRIO confirmar explicitamente (userConfirmed: true). Registre em note o porquê (ex.: CNAE relacionado). Vendas retidas desse produto viram nota automaticamente.',
      inputSchema: z.object({
        id: z.string(),
        taxProfile: TaxProfileSchema,
        userConfirmed: z
          .boolean()
          .describe('O usuário confirmou explicitamente esta tributação nesta conversa'),
        note: z
          .string()
          .max(500)
          .optional()
          .describe('Justificativa, ex.: "CNAE 6201-5/01 — desenvolvimento de software"'),
      }),
    },
    ({ id, taxProfile, userConfirmed, note }) =>
      run(async () => {
        const product = await c.products.confirmTax(tenant, id, taxProfile, {
          userConfirmed,
          note,
          via: 'MCP',
        });
        return {
          product: toProductView(product),
          releasedHeldSales: await c.sales.resumeHeld(tenant.id),
        };
      })
  );

  server.registerTool(
    'list_products',
    {
      title: 'Listar produtos',
      description: 'Lista os produtos/serviços cadastrados',
      inputSchema: z.object({
        search: z.string().optional(),
        page: z.number().int().positive().optional(),
      }),
      annotations: readOnly,
    },
    (input) =>
      run(async () => {
        const page = await c.products.list(tenant.id, input);
        return { ...page, items: page.items.map(toProductView) };
      })
  );

  server.registerTool(
    'get_product',
    {
      title: 'Detalhar produto',
      description: 'Dados e tributação de um produto',
      inputSchema: z.object({ id: z.string() }),
      annotations: readOnly,
    },
    ({ id }) => run(async () => toProductView(await c.products.get(tenant.id, id)))
  );

  server.registerTool(
    'deactivate_product',
    {
      title: 'Desativar produto',
      description: 'Desativa o produto (não pode mais ser vendido; notas antigas não mudam)',
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true },
    },
    ({ id }) => run(() => c.products.deactivate(tenant.id, id))
  );
}
