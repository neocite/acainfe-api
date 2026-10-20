import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { readOnly, run } from '../tool-support.js';

/** Certificado A1: status e link seguro de envio. */
export function registerCertificateTools(server: McpServer, c: Container, tenant: Tenant): void {
  server.registerTool(
    'get_certificate_status',
    {
      title: 'Status do certificado A1',
      description: 'Validade e situação do certificado digital usado na emissão',
      annotations: readOnly,
    },
    () => run(() => c.certificates.status(tenant.id))
  );

  server.registerTool(
    'create_certificate_upload_link',
    {
      title: 'Link para enviar o certificado',
      description:
        'Gera um link (válido por 30 min) de uma página segura onde o usuário envia o certificado A1 (.pfx) e a senha. Recomendado: o certificado não passa pela conversa.',
    },
    () => run(async () => c.certificates.createUploadLink(tenant.id))
  );

  server.registerTool(
    'upload_certificate',
    {
      title: 'Enviar certificado A1 (base64)',
      description:
        'Envia o certificado A1 em base64 com a senha. ATENÇÃO: o conteúdo e a senha trafegam pela conversa com a IA — prefira create_certificate_upload_link.',
      inputSchema: z.object({ pfxBase64: z.string(), password: z.string() }),
    },
    ({ pfxBase64, password }) =>
      run(() => c.certificates.upload(tenant, Buffer.from(pfxBase64, 'base64'), password))
  );
}
