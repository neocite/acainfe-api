import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  APP_VERSION: z.string().default('acainfe-0.1.0'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default('acainfe'),
  /** Chave para criar empresas (operação administrativa). */
  ADMIN_API_KEY: z.string().min(24),
  /** Chave do backend do app web (Replit). Sem ela, as rotas /v1/app ficam desabilitadas. */
  APP_API_KEY: z.string().min(32).optional(),
  BRASILAPI_URL: z.string().url().default('https://brasilapi.com.br/api/cnpj/v1'),
  ABACATEPAY_API_URL: z.string().url().default('https://api.abacatepay.com/v2'),
  /** Master keys para envelope encryption: "k1:<base64 32 bytes>,k2:<...>". */
  MASTER_KEYS: z.string().min(1),
  MASTER_KEY_ID: z.string().default('k1'),
  PUBLIC_BASE_URL: z.string().url().optional(),
  LINK_SIGNING_SECRET: z.string().min(24),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('açaínfe <notas@xn--aanfe-yra7b.com>'),
  UAZAPI_BASE_URL: z.string().url().optional(),
  UAZAPI_TOKEN: z.string().optional(),
  SEFIN_PRODUCTION_URL: z.string().url().default('https://sefin.nfse.gov.br/SefinNacional'),
  SEFIN_HOMOLOGATION_URL: z
    .string()
    .url()
    .default('https://sefin.producaorestrita.nfse.gov.br/SefinNacional'),
  ADN_PRODUCTION_URL: z.string().url().default('https://adn.nfse.gov.br'),
  ADN_HOMOLOGATION_URL: z.string().url().default('https://adn.producaorestrita.nfse.gov.br'),
  /**
   * Municípios (IBGE, separados por vírgula) em que ME/EPP emitem pelo Ginfes da prefeitura em vez
   * do Emissor Nacional. `none` = todos pelo nacional. Cada empresa pode forçar com `fiscalProvider`.
   */
  GINFES_CITIES: z.string().default('3548708'),
  GINFES_PRODUCTION_URL: z
    .string()
    .url()
    .default('https://producao.ginfes.com.br/ServiceGinfesImpl'),
  GINFES_HOMOLOGATION_URL: z
    .string()
    .url()
    .default('https://homologacao.ginfes.com.br/ServiceGinfesImpl'),
  /** Modo piloto: cada nota do Ginfes espera aprovação (approve_invoice) antes do envio. */
  GINFES_PILOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Grupos da reforma tributária no lote do Ginfes: nbs, trib, ibscbs (separados por vírgula).
   * Formato igual ao de uma NFS-e autorizada em SBC. `none` = sem os campos da reforma.
   */
  GINFES_RTC_GROUPS: z
    .string()
    .default('nbs,trib,ibscbs')
    .transform((v) =>
      v
        .split(',')
        .map((g) => g.trim())
        .filter((g): g is 'nbs' | 'trib' | 'ibscbs' => ['nbs', 'trib', 'ibscbs'].includes(g))
    ),
  /** Esperas (ms) entre consultas do lote; depois disso a fila consulta de novo mais tarde. */
  GINFES_POLL_DELAYS_MS: z
    .string()
    .default('3000,5000,8000,12000')
    .transform((v) => v.split(',').filter(Boolean).map(Number)),
  /**
   * Municípios (IBGE) em que ME/EPP emitem pela NFS-e Paulistana (prefeitura de São Paulo).
   * `none` = todos pelo nacional (a partir de 01/11/2026 o Simples de SP é obrigado ao Emissor Nacional).
   */
  PAULISTANA_CITIES: z.string().default('3550308'),
  /** Web service síncrono da prefeitura de SP (aceita leiautes 1 e 2). Não há homologação. */
  PAULISTANA_URL: z.string().url().default('https://nfews.prefeitura.sp.gov.br/lotenfe.asmx'),
  /** Modo piloto: cada nota de SP espera aprovação (approve_invoice) antes do envio. */
  PAULISTANA_PILOT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Preço por NFS-e emitida, em centavos (oferta de lançamento: 80). */
  BILLING_PRICE_PER_INVOICE_CENTS: z.coerce.number().int().min(0).default(80),
  /** Dias com saldo em aberto antes de pausar a emissão. */
  BILLING_GRACE_DAYS: z.coerce.number().int().min(1).default(7),
  BILLING_PIX_EXPIRES_IN_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(3 * 86_400),
  /** API key da conta AbacatePay DO AÇAÍNFE (recebe os pagamentos dos clientes). Permissão TRANSPARENT:CREATE. */
  BILLING_ABACATEPAY_API_KEY: z.string().optional(),
  /** Segredo do webhook da conta AbacatePay do açaínfe (evento transparent.completed). */
  BILLING_ABACATEPAY_WEBHOOK_SECRET: z.string().min(16).optional(),
  /**
   * Nota mensal do uso do açaínfe: CNPJ da empresa que emite (a operadora) e o externalId do produto
   * "prestação de serviço açaí nfe". Sem os dois, nenhuma nota de uso é emitida.
   */
  BILLING_INVOICE_ISSUER_CNPJ: z.string().optional(),
  BILLING_INVOICE_PRODUCT_EXTERNAL_ID: z.string().optional(),
  /**
   * CNPJs de teste (separados por vírgula): o onboarding não consulta a Receita e usa uma empresa
   * fictícia do Simples em São Bernardo. Para testar com certificado autoassinado; apague depois no banco.
   */
  TEST_COMPANY_CNPJS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
    ),
  /**
   * Confiança no certificado enviado: `icp-brasil` exige cadeia até uma raiz da ICP-Brasil (padrão);
   * `any` aceita qualquer um (só testes automatizados). CNPJs de TEST_COMPANY_CNPJS podem usar autoassinado.
   */
  CERTIFICATE_TRUST: z.enum(['icp-brasil', 'any']).default('icp-brasil'),
  /** Régua de ativação: lembretes por WhatsApp/e-mail a quem parou no meio do cadastro. */
  ACTIVATION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Onde o usuário continua o cadastro (link dos lembretes). */
  APP_URL: z.string().url().default('https://acainfe.com'),
  /** Resumo diário (9h) de quem está travado, para quem opera o açaínfe. Vazio = sem resumo. */
  ACTIVATION_DIGEST_EMAIL: z.string().email().optional(),
  ACTIVATION_DIGEST_WHATSAPP: z.string().optional(),
  JOBS_ENABLED: bool.default(true),
  JOBS_PROCESS_EVERY: z.string().default('5 seconds'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // `CHAVE=` vazio no .env equivale a não definida (opcionais não falham por string vazia).
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== '')
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}

export function parseMasterKeys(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw.split(',').map((pair) => {
      const [id, key] = pair.split(':');
      if (!id || !key) throw new Error('MASTER_KEYS deve estar no formato id:base64[,id:base64]');
      return [id.trim(), key.trim()];
    })
  );
}
