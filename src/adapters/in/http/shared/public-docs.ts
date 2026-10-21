import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Rotas que não entram na documentação pública: administração interna e o backend do app web
 * (autenticado com a chave do app). Elas continuam funcionando; só não aparecem em /docs.
 */
const INTERNAL_PREFIXES = ['/v1/admin', '/v1/app'];

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

**Agentes de IA:** o mesmo serviço está disponível via MCP em https://api.acainfe.com/mcp (HTTP streamable, mesma chave). Guia para agentes: https://acainfe.com/llms.txt.`;

/** Remove da documentação pública as rotas internas (admin e backend do app). */
export function publicApiDocument(doc: OpenAPIObject): OpenAPIObject {
  const paths = Object.fromEntries(
    Object.entries(doc.paths).filter(
      ([path]) => !INTERNAL_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
    )
  );
  const usedTags = new Set(
    Object.values(paths).flatMap((item) =>
      Object.values(item as Record<string, { tags?: string[] }>).flatMap((op) => op?.tags ?? [])
    )
  );
  return {
    ...doc,
    paths,
    tags: doc.tags?.filter((t) => usedTags.has(t.name)),
  };
}
