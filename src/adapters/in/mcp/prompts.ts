import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Atalhos para o usuário no cliente de IA. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'configurar_empresa',
    {
      title: 'Configurar minha empresa no açaínfe',
      description: 'Guia de configuração: dados fiscais, certificado, logo, produtos e AbacatePay',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Quero deixar minha empresa pronta para emitir notas no açaínfe. Confira meus dados com get_company e get_certificate_status; ' +
              'se faltar certificado, gere o link com create_certificate_upload_link. Depois me ajude a cadastrar meus serviços como produtos ' +
              '(sugira o código com search_service_codes e confira a alíquota com get_municipal_rate), pergunte se quero colocar meu logo na nota ' +
              'e, se eu vender pelo AbacatePay, ative a integração com enable_abacatepay_integration usando os ids dos meus produtos de lá como externalId.',
          },
        },
      ],
    })
  );

  server.registerPrompt(
    'emitir_nota',
    {
      title: 'Emitir nota fiscal',
      description: 'Emite uma NFS-e para um cliente',
      argsSchema: z.object({
        pedido: z.string().describe('Ex.: "consultoria de 2h para a Maria, R$ 300"'),
      }),
    },
    ({ pedido }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Emita a nota fiscal deste pedido: ${pedido}. Procure o cliente com list_customers (ou cadastre), ` +
              'escolha o produto com list_products, confirme comigo os valores e então use issue_invoice. Acompanhe até a nota ser emitida.',
          },
        },
      ],
    })
  );
}
