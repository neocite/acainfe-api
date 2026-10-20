import '@fastify/multipart';
import { Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import type { Container } from '../../../../config/container.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import type { Tenant } from '../../../../domain/tenant/tenant.js';
import { readMultipart } from '../shared/multipart.js';
import { ApiKeyGuard, CONTAINER, CurrentTenant } from '../shared/support.js';
import type { AuthedRequest } from '../shared/support.js';

@ApiTags('certificados')
@Controller('v1')
export class CertificateUploadController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Post('certificates/upload-link')
  @UseGuards(ApiKeyGuard)
  @ApiSecurity('apiKey')
  @ApiOperation({
    summary: 'Gera link temporário (30 min) de uma página para enviar o certificado A1',
  })
  link(@CurrentTenant() tenant: Tenant) {
    return this.c.certificates.createUploadLink(tenant.id);
  }

  @Get('public/certificate-upload/:token')
  @ApiExcludeEndpoint()
  async page(@Param('token') token: string, @Res() reply: FastifyReply) {
    const tenantId = this.c.uploadLinks.verify(token);
    if (!tenantId)
      return reply
        .status(410)
        .type('text/html; charset=utf-8')
        .send(pageHtml({ expired: true }));
    const tenant = await this.c.tenants.get(tenantId);
    return reply.type('text/html; charset=utf-8').send(pageHtml({ company: tenant.legalName }));
  }

  @Post('public/certificate-upload/:token')
  @ApiExcludeEndpoint()
  async upload(
    @Param('token') token: string,
    @Req() req: AuthedRequest,
    @Res() reply: FastifyReply
  ) {
    const tenantId = this.c.uploadLinks.verify(token);
    if (!tenantId)
      return reply
        .status(410)
        .type('text/html; charset=utf-8')
        .send(pageHtml({ expired: true }));
    const tenant = await this.c.tenants.get(tenantId);
    try {
      if (!req.isMultipart()) throw DomainError.validation('Envie o formulário');
      const { file, fields } = await readMultipart(req);
      if (!file?.length || fields.password === undefined)
        throw DomainError.validation('Envie o arquivo .pfx e a senha');
      const status = await this.c.certificates.upload(tenant, file, fields.password);
      const until = status.metadata!.notAfter.toLocaleDateString('pt-BR');
      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .send(pageHtml({ company: tenant.legalName, success: until }));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return reply
        .status(422)
        .type('text/html; charset=utf-8')
        .send(pageHtml({ company: tenant.legalName, error: error.message }));
    }
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Página mínima e autocontida (sem JS externo) para envio do certificado. */
function pageHtml(state: {
  company?: string;
  expired?: boolean;
  error?: string;
  success?: string;
}): string {
  const body = state.expired
    ? '<h1>Link expirado</h1><p>Peça um novo link ao seu assistente (ferramenta <code>create_certificate_upload_link</code>).</p>'
    : state.success
      ? `<h1>Certificado recebido ✅</h1><p>O certificado de <b>${esc(state.company ?? '')}</b> foi validado e é válido até <b>${esc(state.success)}</b>. Você já pode fechar esta página.</p>`
      : `<h1>Enviar certificado A1</h1>
         <p>Empresa: <b>${esc(state.company ?? '')}</b></p>
         ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
         <form method="post" enctype="multipart/form-data">
           <label>Senha do certificado<input type="password" name="password" required autocomplete="off"></label>
           <label>Arquivo .pfx / .p12<input type="file" name="file" accept=".pfx,.p12" required></label>
           <button type="submit">Enviar</button>
         </form>
         <p class="note">O arquivo vai direto para o açaínfe e é armazenado criptografado. Ele não passa pela conversa com a IA.</p>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>açaínfe — certificado</title>
<style>
:root{--bg:#f7f7f5;--fg:#1b1b1b;--card:#fff;--muted:#666;--accent:#1f7a4d;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--card:#1e1e1e;--muted:#aaa;--accent:#3fb37f;--err:#f97066}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px}
main{background:var(--card);max-width:440px;width:100%;padding:28px;border-radius:12px;box-shadow:0 1px 4px #0002}
h1{font-size:1.3rem;margin-top:0}label{display:block;margin:14px 0;font-weight:600}
input{display:block;width:100%;margin-top:6px;padding:10px;box-sizing:border-box;font:inherit;color:inherit;background:transparent;border:1px solid #8886;border-radius:8px}
button{margin-top:8px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.note{color:var(--muted);font-size:.85rem}.err{color:var(--err);font-weight:600}
</style></head><body><main>${body}</main></body></html>`;
}
