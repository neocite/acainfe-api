import type { OpenAPIObject } from '@nestjs/swagger';
import { PUBLIC_SCHEMAS, SUCCESS_SCHEMAS, VERSIONING_POLICY } from './public-schemas.js';

/**
 * Rotas que não entram na documentação pública: administração interna, o backend do app web
 * (autenticado com a chave do app), os webhooks chamados pelo gateway e a criação de empresa (só
 * admin). Elas continuam funcionando; só não aparecem em /docs e /openapi.json.
 */
const INTERNAL_PREFIXES = ['/v1/admin', '/v1/app', '/v1/webhooks'];
const INTERNAL_PATHS = new Set(['/v1/tenants']);

let publicDocument: (() => OpenAPIObject) | undefined;

/** Registra (no boot) como montar o contrato público; servido em /docs-json e /openapi.json. */
export function setPublicOpenApi(factory: () => OpenAPIObject): void {
  let cached: OpenAPIObject | undefined;
  publicDocument = () => (cached ??= factory());
}

export const getPublicOpenApi = (): OpenAPIObject | undefined => publicDocument?.();

export const PUBLIC_API_DESCRIPTION = `Emissão de NFS-e com a tributação de cada produto, para quem vende no AbacatePay.

**Autenticação:** gere uma chave em https://acainfe.com (menu "Agentes de IA") e envie no cabeçalho \`x-api-key\` (ou \`Authorization: Bearer <chave>\`).

**Valores inteiros:** dinheiro em centavos (R$ 82,20 = 8220) e percentuais em pontos-base (2,01% = 201).

**Exemplo — emitir uma nota:**
\`\`\`
curl -X POST https://api.acainfe.com/v1/sales \\
  -H "x-api-key: <chave>" -H "Content-Type: application/json" \\
  -d '{"externalId":"pedido-123","customer":{"name":"Ana Souza","taxId":"52998224725","email":"ana@exemplo.com"},"items":[{"productExternalId":"prod_abc","totalCents":9700}]}'
\`\`\`
A emissão é assíncrona: acompanhe com \`GET /v1/invoices/{id}\`.

**Erros:** toda resposta 4xx/5xx tem o formato \`{ "error": "<CÓDIGO>", "message": "...", "details": {...} }\` (esquema \`Error\`). Códigos: VALIDATION (422), NOT_FOUND (404), CONFLICT e INVALID_STATE (409), UNAUTHORIZED (401), CERTIFICATE_INVALID e CERTIFICATE_MISSING (422), UNAVAILABLE (503), INTERNAL (500).

${VERSIONING_POLICY}

**Agentes de IA:** o mesmo serviço está disponível via MCP em https://api.acainfe.com/mcp (HTTP streamable, mesma chave). Guia para agentes: https://acainfe.com/llms.txt.`;

/** Remove da documentação pública as rotas internas (admin e backend do app). */
export function publicApiDocument(doc: OpenAPIObject): OpenAPIObject {
  const paths = Object.fromEntries(
    Object.entries(doc.paths).filter(
      ([path]) =>
        !INTERNAL_PATHS.has(path) &&
        !INTERNAL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
    )
  );
  const usedTags = new Set(
    Object.values(paths).flatMap((item) =>
      Object.values(item as Record<string, { tags?: string[] }>).flatMap((op) => op?.tags ?? [])
    )
  );
  return {
    ...doc,
    // Os esquemas vêm do Zod em JSON Schema 2020-12 (const, exclusiveMinimum numérico, type null):
    // é o dialeto do OpenAPI 3.1, não do 3.0 que o Nest declara por padrão.
    openapi: '3.1.0',
    paths: withTypedResponses(stripSchemaDialect(paths)),
    tags: doc.tags?.filter((t) => usedTags.has(t.name)),
    components: {
      ...doc.components,
      schemas: { ...doc.components?.schemas, ...PUBLIC_SCHEMAS },
    },
  };
}

/** Remove o `$schema` que o Zod põe em cada esquema (inválido dentro de um documento OpenAPI). */
function stripSchemaDialect<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSchemaDialect) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '$schema')
        .map(([key, v]) => [key, stripSchemaDialect(v)])
    ) as T;
  }
  return value;
}

type Operation = {
  security?: unknown[];
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
};
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

/**
 * Respostas tipadas: o esquema de sucesso de cada operação (quando conhecido) e o modelo de erro
 * (`Error`) em 4xx/5xx — inclusive 401 nas rotas autenticadas e 404 nas que recebem {id}.
 */
function withTypedResponses(paths: OpenAPIObject['paths']): OpenAPIObject['paths'] {
  const out: OpenAPIObject['paths'] = {};
  for (const [path, item] of Object.entries(paths)) {
    const ops: Record<string, Operation> = {};
    for (const [method, op] of Object.entries(item as Record<string, Operation>)) {
      const responses = { ...op.responses };
      const success = SUCCESS_SCHEMAS[`${method.toUpperCase()} ${path}`];
      const okCode = Object.keys(responses).find((c) => c.startsWith('2')) ?? '200';
      if (success && !responses[okCode]?.content) {
        responses[okCode] = {
          description: responses[okCode]?.description || 'Sucesso',
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${success}` } },
          },
        };
      }
      const isPublic = path.startsWith('/v1/public') || path === '/health';
      if (!isPublic) {
        responses['401'] ??= errorResponse('Chave ausente ou inválida (UNAUTHORIZED)');
      }
      if (path.includes('{id}')) responses['404'] ??= errorResponse('Não encontrado (NOT_FOUND)');
      responses['4XX'] ??= errorResponse(
        'Erro do pedido: dados inválidos (VALIDATION), conflito (CONFLICT/INVALID_STATE) etc.'
      );
      responses['5XX'] ??= errorResponse(
        'Indisponibilidade (UNAVAILABLE) ou erro interno (INTERNAL); pode tentar de novo'
      );
      // Rotas públicas declaram explicitamente "sem autenticação" (security: []).
      ops[method] = isPublic ? { ...op, security: [], responses } : { ...op, responses };
    }
    out[path] = ops as OpenAPIObject['paths'][string];
  }
  return out;
}
