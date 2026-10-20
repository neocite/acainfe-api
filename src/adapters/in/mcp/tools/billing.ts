import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { readOnly, run } from '../tool-support.js';

/** Cobrança do açaínfe (R$ por nota emitida). */
export function registerBillingTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'get_billing',
    {
      title: 'Saldo a pagar ao açaínfe',
      description:
        'Quanto a empresa deve ao açaínfe (R$ por nota emitida), crédito, e a data em que a emissão será pausada se não pagar. Se status = BLOCKED, a emissão está pausada.',
      annotations: readOnly,
    },
    () => run(() => c.billing.summary(tenant.id))
  );

  server.registerTool(
    'list_billing_charges',
    {
      title: 'Extrato de cobranças',
      description: 'Uma cobrança por nota emitida, com status (OPEN/PAID)',
      inputSchema: z.object({ page: z.number().int().positive().optional() }),
      annotations: readOnly,
    },
    ({ page }) => run(() => c.billing.listCharges(tenant.id, { page }))
  );

  server.registerTool(
    'pay_billing',
    {
      title: 'Gerar Pix do saldo',
      description:
        'Gera o Pix (copia e cola) para pagar o saldo em aberto. Mostre o código ao usuário. Após o pagamento, a emissão pausada é retomada automaticamente.',
    },
    () =>
      run(async () => {
        const p = await c.billing.createPayment(tenant);
        return {
          amountCents: p.amountCents,
          pixCopyPaste: p.pixCopyPaste,
          expiresAt: p.expiresAt,
          status: p.status,
        };
      })
  );
}
