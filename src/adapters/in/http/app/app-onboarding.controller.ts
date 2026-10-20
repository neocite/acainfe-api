import '@fastify/multipart';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Container } from '../../../../config/container.js';
import type { User } from '../../../../domain/account/user.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { toConnectAbacatePayView } from '../../presenters.js';
import {
  BusinessTypeSchema,
  CompanyIssRateSchema,
  ConnectAbacatePaySchema,
  RecreateWebhookSchema,
} from '../../schemas.js';
import { AppHeaders, AppUserGuard, CurrentUser } from '../shared/app-auth.js';
import type { AppRequest } from '../shared/app-auth.js';
import { schema } from '../shared/openapi.js';
import { CONTAINER, parseInput } from '../shared/support.js';

const ProfileSchema = z.object({
  name: z.string().min(1).optional(),
  whatsapp: z.string().optional().describe('WhatsApp com DDD'),
});

const CompleteCompanySchema = z.object({
  businessType: BusinessTypeSchema.optional(),
  approximateTaxes: z
    .object({
      rateBps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .describe('Percentual aproximado (IBPT) em pontos-base: 15,53% = 1553'),
      descriptionTemplate: z
        .string()
        .max(300)
        .describe(
          'Texto na discriminação. Tags [ValorTributos] e [PercentualTributos]. Ex.: Valor aprox dos tributos: R$ [ValorTributos]. Fonte: IBPT'
        ),
    })
    .optional()
    .describe('Tributos aproximados (Lei 12.741), confirmados com o contador'),
  issRateBps: CompanyIssRateSchema.optional().describe(
    'Só quando readiness.missing pedir issRateBps (prefeitura não publica a alíquota)'
  ),
  municipalRegistration: z.string().optional().describe('Inscrição municipal (CCM)'),
  simplesNacionalTaxRateBps: z
    .number()
    .int()
    .min(0)
    .max(3_300)
    .optional()
    .describe(
      'Alíquota efetiva do Simples em pontos-base, inteiro (6% = 600; 6,25% = 625), do DAS'
    ),
  taxRegime: z
    .enum(['MEI', 'SIMPLES_NACIONAL', 'SIMPLES_NACIONAL_EXCESSO', 'LUCRO_PRESUMIDO', 'LUCRO_REAL'])
    .optional(),
  tradeName: z.string().optional(),
  issuesElsewhere: z.boolean().optional().describe('Já emite NFS-e por outro sistema?'),
  dpsSeries: z
    .string()
    .optional()
    .describe('Série usada no açaínfe (padrão: 900 se já emite em outro sistema)'),
  nextDpsNumber: z.number().int().positive().optional(),
});

@ApiTags('app (onboarding)')
@AppHeaders()
@UseGuards(AppUserGuard)
@Controller('v1/app')
export class AppOnboardingController {
  constructor(@Inject(CONTAINER) private readonly c: Container) {}

  @Get('me')
  @ApiOperation({ summary: 'Usuário logado e suas empresas, com status do onboarding de cada uma' })
  async me(@CurrentUser() user: User) {
    const tenants = await this.c.accounts.tenantsOf(user);
    return { user, companies: await Promise.all(tenants.map((t) => this.c.onboarding.status(t))) };
  }

  @Put('me')
  @ApiOperation({ summary: 'Etapa 1: nome e WhatsApp (o e-mail vem do login)' })
  @ApiBody({ schema: schema(ProfileSchema) })
  updateProfile(@CurrentUser() user: User, @Body() body: unknown) {
    return this.c.accounts.updateProfile(user, parseInput(ProfileSchema, body));
  }

  @Post('onboarding/certificate')
  @ApiOperation({
    summary:
      'Etapa 2: certificado A1 (multipart "file" + "password", ou JSON {pfxBase64, password}). Descobre o CNPJ, consulta a Receita e responde se o município já está liberado (READY) ou na lista de espera (WAITLIST).',
  })
  async certificate(@CurrentUser() user: User, @Req() req: AppRequest) {
    let pfx: Buffer | undefined;
    let password: string | undefined;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') pfx = await part.toBuffer();
        else if (part.fieldname === 'password') password = String(part.value);
      }
    } else {
      const body = parseInput(
        z.object({ pfxBase64: z.string().min(1), password: z.string() }),
        req.body
      );
      pfx = Buffer.from(body.pfxBase64, 'base64');
      password = body.password;
    }
    if (!pfx || password === undefined)
      throw DomainError.validation('Envie o arquivo .pfx e a senha');
    return this.c.onboarding.submitCertificate(user, pfx, password);
  }

  @Get('companies/:tenantId')
  @ApiOperation({
    summary: 'Status da empresa: disponibilidade (READY/WAITLIST), pendências e produtos a revisar',
  })
  async company(@CurrentUser() user: User, @Param('tenantId') tenantId: string) {
    return this.c.onboarding.status(await this.c.accounts.ownedTenant(user, tenantId));
  }

  @Patch('companies/:tenantId')
  @ApiOperation({
    summary: 'Etapa 3: dados que a Receita não informa (inscrição municipal, alíquota do Simples)',
  })
  @ApiBody({ schema: schema(CompleteCompanySchema) })
  async complete(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.onboarding.completeCompany(tenant, parseInput(CompleteCompanySchema, body));
  }

  @Post('companies/:tenantId/abacatepay')
  @ApiOperation({
    summary:
      'Etapa 4: key do AbacatePay (permissões PRODUCT:READ e WEBHOOK:CREATE). Cria o webhook e importa o catálogo; a tributação de cada produto é definida depois via MCP.',
  })
  @ApiBody({ schema: schema(ConnectAbacatePaySchema) })
  async abacatepay(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    const { apiKey, ...options } = parseInput(ConnectAbacatePaySchema, body);
    return toConnectAbacatePayView(
      await this.c.onboarding.connectAbacatePay(tenant, apiKey, options)
    );
  }

  @Post('companies/:tenantId/abacatepay/webhook')
  @ApiOperation({
    summary:
      'Cria um webhook novo no AbacatePay apontando para a URL atual da API (o AbacatePay não deixa editar a URL). O antigo passa a ser recusado e pode ser apagado no painel',
  })
  @ApiBody({ schema: schema(RecreateWebhookSchema), required: false })
  async recreateWebhook(
    @CurrentUser() user: User,
    @Param('tenantId') tenantId: string,
    @Body() body: unknown
  ) {
    const tenant = await this.c.accounts.ownedTenant(user, tenantId);
    return this.c.onboarding.recreateAbacatePayWebhook(
      tenant,
      parseInput(RecreateWebhookSchema, body).apiKey
    );
  }
}
