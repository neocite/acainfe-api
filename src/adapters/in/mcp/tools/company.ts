import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { toConnectAbacatePayView } from '../../presenters.js';
import {
  BusinessTypeSchema,
  CompanyIssRateSchema,
  ConnectAbacatePaySchema,
  RecreateWebhookSchema,
  NumberingSchema,
  UpdateTenantSchema,
} from '../../schemas.js';
import { readOnly, run } from '../tool-support.js';

/** Empresa: dados fiscais, "o que vende", numeração, logo e integração com o AbacatePay. */
export function registerCompanyTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'get_company',
    {
      title: 'Dados da empresa emissora',
      description:
        'Cadastro fiscal da empresa: CNAEs (atividades), regime, município, pendências para emitir (readiness) e situação na lista de espera',
      annotations: readOnly,
    },
    () =>
      run(async () => {
        const status = await c.onboarding.status(tenant);
        return {
          ...status.tenant,
          availability: status.availability,
          readiness: status.readiness,
          certificate: status.certificate,
          abacatepay: status.abacatepay,
          emission: status.emission,
          pendingTaxReview: status.pendingTaxReview,
        };
      })
  );

  server.registerTool(
    'set_business_type',
    {
      title: 'Definir o que a empresa vende',
      description:
        'Resposta de "O que você vende?": INFOPRODUCER (cursos, treinamentos, mentorias) ou MICROSAAS (assinaturas de software). Aplica a tributação padrão aos produtos pendentes. issRateBps só quando readiness pedir (prefeitura sem alíquota publicada).',
      inputSchema: z.object({
        businessType: BusinessTypeSchema,
        issRateBps: CompanyIssRateSchema.optional(),
      }),
    },
    (input) =>
      run(async () => {
        const status = await c.onboarding.completeCompany(tenant, input);
        return {
          businessType: status.tenant.businessType,
          issRateBps: status.tenant.issRateBps,
          readiness: status.readiness,
          pendingTaxReview: status.pendingTaxReview,
          releasedHeldSales: await c.sales.resumeHeld(tenant.id),
        };
      })
  );

  server.registerTool(
    'update_company',
    {
      title: 'Atualizar dados da empresa',
      description:
        'Atualiza razão social, regime tributário, alíquota do Simples, ambiente (HOMOLOGATION/PRODUCTION), notificações etc.',
      inputSchema: UpdateTenantSchema,
    },
    (patch) => run(() => c.tenants.update(tenant.id, patch))
  );

  server.registerTool(
    'set_company_logo',
    {
      title: 'Definir logo da nota',
      description:
        'Define o logo exibido no PDF (DANFSe). Envie imageUrl (https pública) ou imageBase64 (PNG/JPEG até 512 KB).',
      inputSchema: z.object({
        imageUrl: z.string().url().optional(),
        imageBase64: z.string().optional(),
      }),
    },
    ({ imageUrl, imageBase64 }) =>
      run(() =>
        c.tenants.setLogo(tenant.id, {
          url: imageUrl,
          data: imageBase64
            ? Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
            : undefined,
        })
      )
  );

  server.registerTool(
    'remove_company_logo',
    {
      title: 'Remover logo',
      description: 'Remove o logo do PDF da nota',
      annotations: { destructiveHint: true },
    },
    () => run(async () => (await c.tenants.removeLogo(tenant.id), { removed: true }))
  );

  server.registerTool(
    'set_invoice_numbering',
    {
      title: 'Numeração das notas',
      description:
        'Define série e próximo número das notas. Pergunte ao usuário se ele já emite NFS-e por outro sistema (eNotas, portal da prefeitura…): se sim, use issuesElsewhere=true (série exclusiva 900) ou a série/próximo número livres que ele informar. Evita colisão com notas existentes.',
      inputSchema: NumberingSchema,
    },
    (input) => run(() => c.tenants.setNumbering(tenant.id, input))
  );

  server.registerTool(
    'connect_abacatepay',
    {
      title: 'Conectar o AbacatePay (e buscar pagamentos antigos)',
      description:
        'Conecta com a API key do AbacatePay: cria o webhook sozinho, importa os produtos (com o perfil fiscal da empresa) e, se scanPastSales (padrão), busca os pagamentos antigos que ainda não têm nota e mostra a prévia por mês. NÃO emite nada: depois use list_past_sales, mark_past_sales_already_issued e issue_past_sales. Pode ser chamado de novo para trocar a key sem duplicar o webhook.',
      inputSchema: ConnectAbacatePaySchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ apiKey, ...options }) =>
      run(async () =>
        toConnectAbacatePayView(await c.onboarding.connectAbacatePay(tenant, apiKey, options))
      )
  );

  server.registerTool(
    'enable_abacatepay_integration',
    {
      title: 'Integrar com AbacatePay',
      description:
        'Alternativa manual a connect_abacatepay (prefira connect_abacatepay): só gera a URL do webhook para cadastrar no painel do AbacatePay, sem importar produtos nem buscar pagamentos antigos. Gerar de novo invalida a URL anterior. O externalId dos produtos deve ser o id do produto no AbacatePay.',
      annotations: { openWorldHint: false },
    },
    () =>
      run(async () => {
        if (!c.env.PUBLIC_BASE_URL)
          throw DomainError.validation('PUBLIC_BASE_URL não configurada no servidor');
        const result = await c.tenants.enableAbacatePay(tenant.id, c.env.PUBLIC_BASE_URL);
        return {
          ...result,
          events: [
            'checkout.completed',
            'transparent.completed',
            'checkout.refunded',
            'transparent.refunded',
          ],
        };
      })
  );

  server.registerTool(
    'get_fiscal_settings',
    {
      title: 'Ficha fiscal da empresa',
      description:
        'Tudo o que define as notas: regime, CCM, sistema de emissão, série/numeração, tributação padrão (código nacional e municipal, NBS, ISS, IBS/CBS), tributos aproximados (IBPT), certificado, contador e a tributação de cada produto. Traz também um resumo em texto (campo text) para o usuário conferir com o contador.',
      annotations: readOnly,
    },
    () => run(() => c.fiscalSettings.get(tenant))
  );

  server.registerTool(
    'send_fiscal_settings_to_accountant',
    {
      title: 'Enviar ficha fiscal ao contador',
      description:
        'Envia a ficha fiscal ao contador cadastrado (e-mail e/ou WhatsApp) para ele conferir. Confirme com o usuário antes.',
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    () => run(async () => ({ sentTo: await c.fiscalSettings.sendToAccountant(tenant) }))
  );

  server.registerTool(
    'recreate_abacatepay_webhook',
    {
      title: 'Recriar webhook do AbacatePay',
      description:
        'Cria um webhook novo no AbacatePay apontando para a URL atual do açaínfe (use quando get_company mostrar abacatepay.webhookUpToDate=false, ou se as vendas pararam de chegar). Usa a key já conectada (ou a informada, com WEBHOOK:CREATE). Depois, oriente o usuário a apagar o webhook antigo no painel do AbacatePay.',
      inputSchema: RecreateWebhookSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ apiKey }) => run(() => c.onboarding.recreateAbacatePayWebhook(tenant, apiKey))
  );
}
