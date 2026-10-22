/**
 * Esquemas das respostas da API pública no OpenAPI (só documentação: o formato real vem dos
 * presenters). Campos principais tipados; `additionalProperties` permite evoluir sem quebrar.
 */
type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
});
const str = (description?: string): Schema => ({ type: 'string', description });
const int = (description: string): Schema => ({ type: 'integer', description });
const page = (item: string): Schema =>
  obj(
    {
      items: { type: 'array', items: ref(item) },
      total: int('Total de itens'),
      page: int('Página atual (começa em 1)'),
      pageSize: int('Itens por página'),
    },
    ['items', 'total', 'page', 'pageSize']
  );

export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE',
  'UNAUTHORIZED',
  'CERTIFICATE_INVALID',
  'CERTIFICATE_MISSING',
  'UNAVAILABLE',
  'BAD_REQUEST',
  'HTTP',
  'INTERNAL',
];

export const PUBLIC_SCHEMAS: Record<string, Schema> = {
  Error: obj(
    {
      error: {
        type: 'string',
        enum: ERROR_CODES,
        description: 'Código do erro, estável para tratamento automático',
      },
      message: str('Mensagem em português para o usuário'),
      details: {
        type: 'object',
        additionalProperties: true,
        description: 'Contexto do erro (ex.: campos inválidos em details.issues)',
      },
    },
    ['error', 'message']
  ),
  Invoice: obj(
    {
      id: str('Id da nota no açaínfe'),
      saleId: str(),
      status: {
        type: 'string',
        enum: ['PENDING', 'PROCESSING', 'RETRYING', 'ISSUED', 'REJECTED', 'FAILED', 'CANCELLED'],
      },
      environment: { type: 'string', enum: ['PRODUCTION', 'HOMOLOGATION'] },
      amountCents: int('Valor da nota em centavos'),
      amount: str('Valor formatado (ex.: "97.00")'),
      serviceDescription: str('Discriminação do serviço'),
      competenceDate: { type: 'string', format: 'date-time' },
      customer: { type: 'object', additionalProperties: true, description: 'Tomador' },
      taxProfile: {
        type: 'object',
        additionalProperties: true,
        description: 'Tributação aplicada (código de serviço, NBS, ISS, IBS/CBS)',
      },
      nfse: obj({
        provider: { type: 'string', enum: ['NACIONAL', 'GINFES', 'PAULISTANA'] },
        number: str('Número da NFS-e'),
        accessKey: str('Chave de acesso ou código de verificação'),
        issuedAt: { type: 'string', format: 'date-time' },
        verificationUrl: str('Consulta pública da nota'),
        pdfUrl: str('PDF (link assinado)'),
      }),
      lastErrors: {
        type: 'array',
        items: obj({ code: str(), message: str() }, ['code', 'message']),
      },
      hints: { type: 'array', items: str(), description: 'O que fazer para resolver' },
    },
    ['id', 'status', 'amountCents']
  ),
  Sale: obj(
    {
      id: str(),
      source: { type: 'string', enum: ['API', 'MCP', 'ABACATEPAY', 'ACAINFE_BILLING'] },
      externalId: str('Id da venda na origem (idempotência)'),
      totalCents: int('Total da venda em centavos'),
      invoiceIds: { type: 'array', items: str() },
    },
    ['id', 'externalId']
  ),
  SaleResult: obj(
    {
      sale: ref('Sale'),
      invoices: { type: 'array', items: ref('Invoice') },
      duplicated: { type: 'boolean', description: 'Venda já registrada antes (mesmo externalId)' },
      held: {
        type: 'boolean',
        description: 'Venda retida aguardando produto/tributação; vira nota sozinha depois',
      },
    },
    ['sale', 'invoices', 'duplicated']
  ),
  Product: obj(
    {
      id: str(),
      externalId: str('Id do produto no gateway (ex.: AbacatePay)'),
      name: str(),
      serviceDescription: str(),
      defaultPriceCents: int('Preço de referência em centavos'),
      taxStatus: { type: 'string', enum: ['CONFIRMED', 'PENDING_REVIEW'] },
      active: { type: 'boolean' },
      taxProfile: { type: 'object', additionalProperties: true },
    },
    ['id', 'name', 'taxStatus']
  ),
  Customer: obj({ id: str(), name: str(), email: str(), phone: str(), taxId: { type: 'object' } }, [
    'id',
  ]),
  InvoicePage: page('Invoice'),
  ProductPage: page('Product'),
  CustomerPage: page('Customer'),
  Pricing: obj(
    {
      pricePerInvoiceCents: int('Preço por nota emitida, em centavos'),
      currency: { type: 'string', enum: ['BRL'] },
      monthlyFeeCents: int('Mensalidade em centavos (0)'),
      graceDays: int('Dias para pagar antes de pausar a emissão'),
    },
    ['pricePerInvoiceCents', 'currency']
  ),
  Coverage: obj(
    {
      cities: {
        type: 'array',
        items: obj(
          {
            cityCode: str('Código IBGE (7 dígitos)'),
            cityName: str(),
            uf: str(),
            regimes: { type: 'array', items: str() },
          },
          ['cityCode', 'regimes']
        ),
      },
    },
    ['cities']
  ),
  Health: obj({ status: str() }),
};

/** Resposta de sucesso de cada operação ("MÉTODO caminho" → esquema). */
export const SUCCESS_SCHEMAS: Record<string, string> = {
  'POST /v1/sales': 'SaleResult',
  'GET /v1/invoices': 'InvoicePage',
  'GET /v1/invoices/{id}': 'Invoice',
  'POST /v1/invoices/{id}/cancel': 'Invoice',
  'POST /v1/invoices/{id}/retry': 'Invoice',
  'POST /v1/invoices/{id}/resend': 'Invoice',
  'GET /v1/products': 'ProductPage',
  'POST /v1/products': 'Product',
  'GET /v1/products/{id}': 'Product',
  'PATCH /v1/products/{id}': 'Product',
  'GET /v1/customers': 'CustomerPage',
  'POST /v1/customers': 'Customer',
  'GET /v1/customers/{id}': 'Customer',
  'PATCH /v1/customers/{id}': 'Customer',
  'GET /v1/public/pricing': 'Pricing',
  'GET /v1/public/coverage': 'Coverage',
  'GET /health': 'Health',
};

export const VERSIONING_POLICY = `**Versionamento e descontinuação:** a versão está no caminho (\`/v1\`). Dentro de uma versão, só entram mudanças compatíveis (novos campos, novas rotas, novos valores opcionais). Mudança incompatível só numa nova versão (\`/v2\`). Uma rota ou versão descontinuada continua funcionando por pelo menos 90 dias, responde com os cabeçalhos \`Deprecation\` (RFC 9745) e \`Sunset\` (RFC 8594) e é anunciada em https://acainfe.com/developers e no llms.txt.`;
