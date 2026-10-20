import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { CustomerSchema, UpdateCustomerSchema } from '../../schemas.js';
import { readOnly, run } from '../tool-support.js';

/** Clientes (tomadores). */
export function registerCustomerTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'create_customer',
    {
      title: 'Cadastrar cliente',
      description:
        'Cadastra um cliente (tomador). CPF/CNPJ exige nome. E-mail/WhatsApp recebem a nota automaticamente.',
      inputSchema: CustomerSchema,
    },
    (input) => run(() => c.customers.create(tenant.id, input))
  );

  server.registerTool(
    'list_customers',
    {
      title: 'Listar/buscar clientes',
      description: 'Busca por nome, e-mail, CPF/CNPJ, telefone ou externalId',
      inputSchema: z.object({
        search: z.string().optional(),
        page: z.number().int().positive().optional(),
      }),
      annotations: readOnly,
    },
    (input) => run(() => c.customers.list(tenant.id, input))
  );

  server.registerTool(
    'get_customer',
    {
      title: 'Detalhar cliente',
      description: 'Dados de um cliente',
      inputSchema: z.object({ id: z.string() }),
      annotations: readOnly,
    },
    ({ id }) => run(() => c.customers.get(tenant.id, id))
  );

  server.registerTool(
    'update_customer',
    {
      title: 'Atualizar cliente',
      description: 'Atualiza dados do cliente',
      inputSchema: UpdateCustomerSchema.extend({ id: z.string() }),
    },
    ({ id, ...patch }) => run(() => c.customers.update(tenant.id, id, patch))
  );

  server.registerTool(
    'delete_customer',
    {
      title: 'Excluir cliente',
      description: 'Exclui o cadastro do cliente (notas já emitidas mantêm os dados do tomador)',
      inputSchema: z.object({ id: z.string() }),
      annotations: { destructiveHint: true },
    },
    ({ id }) => run(async () => (await c.customers.delete(tenant.id, id), { deleted: true }))
  );
}
