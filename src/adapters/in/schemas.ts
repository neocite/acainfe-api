import { z } from 'zod';

/** Percentual inteiro em pontos-base (centésimos de %): 2,01% = 201; 15,53% = 1553. */
const bps = (max: number, description: string) =>
  z.number().int().min(0).max(max).describe(description);

/** Schemas de entrada compartilhados entre REST e MCP (mesma validação nos dois adaptadores). */

const address = z.object({
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().optional(),
  district: z.string().min(1),
  cityCode: z.string().regex(/^\d{7}$/, 'Código IBGE de 7 dígitos'),
  zipCode: z.string().min(8),
});

export const TaxProfileSchema = z.object({
  nationalServiceCode: z
    .string()
    .describe('Código de tributação nacional (cTribNac), 6 dígitos. Ex.: 010701'),
  municipalServiceCode: z
    .string()
    .optional()
    .describe('cTribMun, 3 dígitos (se o município exigir)'),
  nbsCode: z.string().optional().describe('Código NBS, 9 dígitos'),
  issRateBps: z
    .number()
    .int()
    .min(200)
    .max(500)
    .optional()
    .describe(
      'Alíquota de ISS em pontos-base, inteiro (2% = 200; 2,01% = 201; 5% = 500). Obrigatória se o ISS for retido'
    ),
  issTaxation: z.enum(['TAXABLE', 'IMMUNE', 'EXPORT', 'NOT_LEVIED']).optional(),
  issRetention: z.enum(['NONE', 'TOMADOR', 'INTERMEDIARIO']).optional(),
  approximateTaxRateBps: bps(
    10_000,
    'Percentual aproximado de tributos (Lei 12.741) em pontos-base: 15,53% = 1553'
  ).optional(),
  federalRetentions: z
    .object({
      irrfRateBps: bps(3_000, 'Retenção em pontos-base (1,5% = 150)').optional(),
      csllRateBps: bps(3_000, 'Retenção em pontos-base (1,5% = 150)').optional(),
      pisRateBps: bps(3_000, 'Retenção em pontos-base (1,5% = 150)').optional(),
      cofinsRateBps: bps(3_000, 'Retenção em pontos-base (1,5% = 150)').optional(),
      inssRateBps: bps(3_000, 'Retenção em pontos-base (1,5% = 150)').optional(),
    })
    .optional(),
  ibsCbs: z
    .object({
      cst: z.string(),
      cClassTrib: z.string(),
      operationIndicator: z.string().describe('cIndOp (6 dígitos)'),
    })
    .optional(),
  foreignTreatment: z
    .enum(['EXPORT', 'TAXABLE'])
    .optional()
    .describe('Venda a tomador no exterior: EXPORT (padrão, exportação de serviço) ou TAXABLE'),
  foreignIbsCbs: z
    .object({ cst: z.string(), cClassTrib: z.string(), operationIndicator: z.string() })
    .optional()
    .describe('IBS/CBS para vendas ao exterior'),
  localServiceCode: z
    .string()
    .optional()
    .describe('Código do serviço no sistema da prefeitura (ABRASF/Ginfes), ex.: 8.02/103911/1551'),
});

export const CreateProductSchema = z.object({
  name: z.string().min(1),
  externalId: z
    .string()
    .optional()
    .describe('Id do produto no seu sistema/gateway (ex.: id do produto no AbacatePay)'),
  serviceDescription: z.string().max(2000).optional().describe('Discriminação do serviço na nota'),
  defaultPriceCents: z.number().int().nonnegative().optional(),
  taxProfile: TaxProfileSchema.optional().describe(
    'Tributação. Omita para aplicar o perfil fiscal padrão da empresa (businessType)'
  ),
});

export const BusinessTypeSchema = z
  .enum(['INFOPRODUCER', 'MICROSAAS'])
  .describe(
    'O que a empresa vende: INFOPRODUCER (cursos, treinamentos, mentorias) ou MICROSAAS (assinaturas de software)'
  );

export const CompanyIssRateSchema = z
  .number()
  .int()
  .min(200)
  .max(500)
  .describe('Alíquota de ISS da empresa em pontos-base (2% = 200; 2,01% = 201; 5% = 500)');

export const UpdateProductSchema = CreateProductSchema.partial().extend({
  taxProfile: TaxProfileSchema.partial().optional(),
});

const ForeignCustomerSchema = z
  .object({
    countryCode: z.string().length(2).describe('País ISO de 2 letras (ex.: US, PT)'),
    nif: z.string().optional().describe('Identificação fiscal no país de origem'),
    noNifReason: z
      .enum(['0', '1', '2'])
      .optional()
      .describe('Sem NIF: 0 não informado, 1 dispensado, 2 não exigido'),
    address: z
      .object({
        street: z.string(),
        number: z.string(),
        complement: z.string().optional(),
        district: z.string(),
        city: z.string(),
        region: z.string(),
        postalCode: z.string(),
      })
      .optional(),
  })
  .describe('Tomador no exterior (em vez de CPF/CNPJ)');

export const CustomerSchema = z.object({
  foreign: ForeignCustomerSchema.optional(),
  externalId: z.string().optional().describe('Id do cliente no seu sistema/gateway'),
  taxId: z.string().optional().describe('CPF ou CNPJ do tomador (opcional para consumidor final)'),
  name: z.string().optional(),
  email: z.string().optional().describe('Se informado, a nota é enviada por e-mail'),
  phone: z
    .string()
    .optional()
    .describe('WhatsApp com DDD; se informado, a nota é enviada por WhatsApp'),
  address: address.optional(),
});

export const CreateSaleSchema = z.object({
  externalId: z.string().min(1).describe('Id da venda/pedido na origem — garante idempotência'),
  customerId: z.string().optional().describe('Cliente já cadastrado (veja list_customers)'),
  customer: CustomerSchema.optional().describe(
    'Dados do tomador; novos clientes são cadastrados automaticamente'
  ),
  items: z
    .array(
      z.object({
        productId: z.string().optional(),
        productExternalId: z.string().optional(),
        quantity: z.number().int().positive().optional().describe('Quantidade inteira (padrão 1)'),
        unitPriceCents: z.number().int().nonnegative().optional(),
        totalCents: z.number().int().nonnegative().optional(),
        description: z.string().max(2000).optional(),
      })
    )
    .min(1),
  totalCents: z.number().int().positive().optional(),
  competenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD')
    .optional()
    .describe('Data de competência (padrão: hoje)'),
});

/** Converte a data de competência (AAAA-MM-DD, horário de Brasília) para Date. */
export const competenceToDate = (value?: string): Date | undefined =>
  value ? new Date(`${value}T12:00:00-03:00`) : undefined;

const taxRegime = z.enum([
  'MEI',
  'SIMPLES_NACIONAL',
  'SIMPLES_NACIONAL_EXCESSO',
  'LUCRO_PRESUMIDO',
  'LUCRO_REAL',
]);
const specialTaxRegime = z.enum([
  'NONE',
  'COOPERATIVE',
  'ESTIMATE',
  'MICROENTERPRISE_MUNICIPAL',
  'NOTARY',
  'PROFESSIONAL_SOCIETY',
]);

export const CreateTenantSchema = z.object({
  cnpj: z.string(),
  legalName: z.string().min(1),
  tradeName: z.string().optional(),
  municipalRegistration: z.string().min(1),
  cityCode: z.string().optional(),
  taxRegime,
  simplesNacionalApuration: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  simplesNacionalTaxRateBps: bps(
    3_300,
    'Alíquota efetiva do Simples em pontos-base (6% = 600; 6,25% = 625)'
  ).optional(),
  specialTaxRegime: specialTaxRegime.optional(),
  sendMunicipalRegistration: z.boolean().optional(),
  environment: z.enum(['PRODUCTION', 'HOMOLOGATION']).optional(),
  email: z.string(),
  phone: z.string().optional(),
  address: address.optional(),
  dpsSeries: z.string().optional(),
  notifications: z
    .object({ email: z.boolean().optional(), whatsapp: z.boolean().optional() })
    .optional(),
  approximateTaxes: z
    .object({
      rateBps: bps(
        10_000,
        'Percentual simplificado em pontos-base (IBPT 15,53% = 1553)'
      ).optional(),
      federalRateBps: bps(10_000, 'Pontos-base').optional(),
      stateRateBps: bps(10_000, 'Pontos-base').optional(),
      municipalRateBps: bps(10_000, 'Pontos-base').optional(),
      source: z.string().optional(),
      descriptionTemplate: z
        .string()
        .max(300)
        .optional()
        .describe('Texto na discriminação. Tags [ValorTributos] e [PercentualTributos]'),
    })
    .optional()
    .describe('Valor aproximado dos tributos (Lei 12.741)'),
  culturalIncentive: z.boolean().optional(),
  businessType: BusinessTypeSchema.optional(),
  issRateBps: CompanyIssRateSchema.optional(),
  fiscalProvider: z
    .enum(['NACIONAL', 'GINFES'])
    .optional()
    .describe(
      'Força o sistema de emissão: NACIONAL (Emissor Nacional) ou GINFES (sistema da prefeitura de São Bernardo do Campo). Omita para seguir a regra do município'
    ),
});

/**
 * Alterações feitas pela própria empresa (API key, MCP). Ambiente e sistema de emissão ficam de fora:
 * só o admin muda (AdminTenantSchema).
 */
export const UpdateTenantSchema = CreateTenantSchema.omit({
  cnpj: true,
  cityCode: true,
  dpsSeries: true,
  environment: true,
  fiscalProvider: true,
})
  .partial()
  .extend({
    defaultService: z
      .object({ taxProfile: TaxProfileSchema, serviceDescription: z.string().optional() })
      .nullable()
      .optional()
      .describe('Serviço padrão: sugestão de tributação para produtos importados (null remove)'),
  });

/** Controles internos da empresa: só pelo admin. */
export const AdminTenantSchema = z.object({
  environment: z
    .enum(['PRODUCTION', 'HOMOLOGATION'])
    .optional()
    .describe('HOMOLOGATION só para testes internos: notas sem valor fiscal'),
  fiscalProvider: z
    .enum(['NACIONAL', 'GINFES'])
    .nullable()
    .optional()
    .describe('Força o sistema de emissão; null volta para a regra do município'),
});

export const ListInvoicesSchema = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim().toUpperCase())
    )
    .pipe(
      z
        .array(
          z.enum(['PENDING', 'PROCESSING', 'RETRYING', 'ISSUED', 'REJECTED', 'FAILED', 'CANCELLED'])
        )
        .optional()
    ),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  customerTaxId: z.string().optional(),
  saleId: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const CancelInvoiceSchema = z.object({
  reasonCode: z
    .enum(['1', '2', '9'])
    .describe('1 = erro na emissão, 2 = serviço não prestado, 9 = outros'),
  reason: z.string().min(15).max(255),
});

export const ResendInvoiceSchema = z.object({
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  to: z.string().optional(),
});

export const UpdateCustomerSchema = CustomerSchema.partial();

export const RefundSaleSchema = z.object({
  reasonCode: z
    .enum(['1', '2', '9'])
    .optional()
    .describe(
      'Motivo do cancelamento: 1 = erro na emissão, 2 = serviço não prestado (padrão), 9 = outros'
    ),
  reason: z.string().min(15).max(255).optional().describe('Justificativa (15 a 255 caracteres)'),
});

export const LogoSchema = z
  .object({
    imageBase64: z.string().optional().describe('PNG ou JPEG em base64 (até 512 KB)'),
    imageUrl: z.string().url().optional().describe('URL https pública da imagem'),
  })
  .refine((v) => v.imageBase64 || v.imageUrl, 'Informe imageBase64 ou imageUrl');

export const NumberingSchema = z.object({
  issuesElsewhere: z
    .boolean()
    .optional()
    .describe(
      'Já emite NFS-e por outro sistema? true → usa série exclusiva do açaínfe (900) se a série não for informada'
    ),
  series: z.string().optional().describe('Série do DPS (1 a 5 dígitos)'),
  nextNumber: z.number().int().positive().optional().describe('Próximo número de nota nesta série'),
});

export const AccountantSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional().describe('E-mail do contador'),
  whatsapp: z.string().optional().describe('WhatsApp do contador com DDD'),
  monthlyReport: z.boolean().optional().describe('Envio automático mensal (padrão: true)'),
  dayOfMonth: z.number().int().min(1).max(28).optional().describe('Dia do envio (padrão: 1)'),
});

export const AccountantReportRequestSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Formato AAAA-MM')
    .optional()
    .describe('Mês de referência (padrão: mês anterior)'),
});

export const ConnectAbacatePaySchema = z.object({
  apiKey: z
    .string()
    .min(10)
    .describe(
      'API key do AbacatePay com PRODUCT:READ, WEBHOOK:CREATE, CHECKOUT:READ, TRANSPARENT:READ, SUBSCRIPTION:READ e CUSTOMER:READ'
    ),
  scanPastSales: z
    .boolean()
    .optional()
    .describe('Buscar pagamentos antigos sem nota (padrão: true). Só mostra a prévia, não emite'),
  monthsBack: z
    .number()
    .int()
    .min(0)
    .max(12)
    .optional()
    .describe('Quantos meses para trás buscar (0 = só o mês atual; padrão 3; máximo 12)'),
});

export const RecreateWebhookSchema = z.object({
  apiKey: z
    .string()
    .min(10)
    .optional()
    .describe('API key do AbacatePay (WEBHOOK:CREATE). Omita para usar a key já conectada'),
});

export const DefaultProductSchema = z.object({
  productId: z
    .string()
    .min(1)
    .nullable()
    .describe(
      'Produto (id no açaínfe) da nota quando o pagamento não informa o produto. null = nenhum: não gera nota'
    ),
});

export const PastSalesScanSchema = z.object({
  monthsBack: z
    .number()
    .int()
    .min(0)
    .max(12)
    .optional()
    .describe('Quantos meses anteriores buscar além do atual (padrão 3)'),
});

export const PastSalesMarkSchema = z.object({
  ids: z.array(z.string()).optional().describe('Vendas específicas (ids da prévia)'),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .describe('Ou todas as vendas do mês AAAA-MM'),
  alreadyIssued: z
    .boolean()
    .describe('true = já tem nota em outro sistema (não emitir); false = desfazer'),
});

export const PastSalesIgnoreSchema = z.object({
  ids: z.array(z.string()).optional().describe('Pagamentos específicos (ids da prévia)'),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .describe('Ou todos os pagamentos do mês AAAA-MM'),
  ignored: z
    .boolean()
    .default(true)
    .describe('true = não é venda (ex.: teste), nunca emitir; false = desfazer'),
  reason: z.string().max(200).optional().describe('Motivo, ex.: "pagamento de teste"'),
});

export const PastSalesIssueSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Formato AAAA-MM')
    .describe('Mês das vendas a emitir'),
  confirmPastPeriod: z
    .boolean()
    .optional()
    .describe(
      'Obrigatório para meses anteriores ao atual: usuário ciente da competência retroativa (contador)'
    ),
  fallbackProductId: z
    .string()
    .optional()
    .describe('Produto usado para Pix avulso sem itens (sem ele, essas vendas ficam de fora)'),
  skipReconciliation: z
    .boolean()
    .optional()
    .describe(
      'Emitir sem cruzar com as notas da prefeitura (reconcile_past_sales). Só com o usuário ciente do risco de duplicidade'
    ),
});

export const PastSalesReconcileSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/, 'Formato AAAA-MM')
    .describe('Mês das vendas (AAAA-MM)'),
});

export const PastSalesApplyReconciliationSchema = PastSalesReconcileSchema.extend({
  confidence: z
    .enum(['HIGH', 'MEDIUM'])
    .describe(
      'Nível mínimo: HIGH = mesmo valor e CPF/CNPJ; MEDIUM = mesmo valor, nome e data próxima'
    ),
  ids: z
    .array(z.string())
    .optional()
    .describe('Só estas vendas (pastSaleId), as que o usuário confirmou'),
});

export const PastSalesListSchema = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      v === undefined
        ? undefined
        : (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim().toUpperCase())
    )
    .pipe(z.array(z.enum(['AVAILABLE', 'ALREADY_ISSUED', 'IMPORTED', 'REFUNDED', 'IGNORED'])).optional()),
});
