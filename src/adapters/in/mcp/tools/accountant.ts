import { McpServer } from '@modelcontextprotocol/server';
import type { Container } from '../../../../config/container.js';
import { previousPeriod } from '../../../../domain/accounting/accountant-report.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { AccountantReportRequestSchema, AccountantSchema } from '../../schemas.js';
import { readOnly, run } from '../tool-support.js';

/** Contador: cadastro e pacote mensal. */
export function registerAccountantTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'set_accountant',
    {
      title: 'Cadastrar contador',
      description:
        'Cadastra o contador da empresa. Todo mês (dia 1, por padrão) ele recebe automaticamente por e-mail e/ou WhatsApp o ZIP com os PDFs e XMLs e a planilha das notas do mês anterior (mesmo layout do eNotas).',
      inputSchema: AccountantSchema,
    },
    (input) => run(async () => ({ accountant: await c.accountant.setAccountant(tenant.id, input) }))
  );

  server.registerTool(
    'send_accountant_report',
    {
      title: 'Enviar notas ao contador agora',
      description:
        'Envia agora ao contador o pacote de um mês (padrão: mês anterior). Útil para reenviar ou antecipar.',
      inputSchema: AccountantReportRequestSchema,
      annotations: { openWorldHint: true },
    },
    ({ period }) =>
      run(() => c.accountant.send(tenant, period ?? previousPeriod(new Date()), 'MANUAL'))
  );

  server.registerTool(
    'list_accountant_reports',
    {
      title: 'Envios ao contador',
      description: 'Histórico dos envios mensais ao contador',
      annotations: readOnly,
    },
    () => run(async () => ({ reports: await c.accountant.history(tenant.id) }))
  );
}
