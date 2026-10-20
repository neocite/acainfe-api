# Mudança na API do açaínfe: emitir notas de vendas passadas do AbacatePay

**Para o Replit Agent.** O app já está no ar. Aplique **somente** as alterações abaixo.

## O que é

Quem conecta o AbacatePay geralmente já tem vendas pagas **sem nota**. Logo depois de conectar, o açaínfe mostra essas vendas agrupadas por mês, e o usuário escolhe se quer emitir.

- **Mês atual:** emite sem atrito.
- **Meses anteriores:** exigem confirmação. A nota sai com a competência do mês da venda, e no Simples o contador pode precisar retificar o PGDAS.
- **Vendas estornadas ou contestadas:** nunca entram.
- **Vendas que já têm nota em outro sistema** (eNotas, portal da prefeitura): o usuário **marca manualmente** para não emitir em duplicidade.

## 1. Etapa 4 (Conectar o AbacatePay): permissões da key

Troque o texto de instrução por:

> "No painel do AbacatePay, crie uma API key com as permissões **PRODUCT:READ, WEBHOOK:CREATE, CHECKOUT:READ, TRANSPARENT:READ, SUBSCRIPTION:READ e CUSTOMER:READ**."

As quatro últimas servem para ler as vendas passadas e os dados dos clientes.

**Já conectou com a key antiga?** Mostre um botão **"Atualizar key"** que chama de novo `POST /v1/app/companies/{tenantId}/abacatepay` com a key nova. Reconectar **não** cria outro webhook e não muda nada do que já funciona.

## 2. Resposta da etapa 4 ganhou `pastSales`

`POST /v1/app/companies/{tenantId}/abacatepay` agora devolve também:

```json
"pastSales": {
  "periods": [
    {
      "period": "2026-10",
      "isCurrentMonth": true,
      "requiresConfirmation": false,
      "available": { "count": 47, "totalCents": 930000, "withoutItems": 2 },
      "alreadyIssued": 0, "imported": 0, "refunded": 1
    },
    {
      "period": "2026-09",
      "isCurrentMonth": false,
      "requiresConfirmation": true,
      "available": { "count": 120, "totalCents": 2310000, "withoutItems": 0 },
      "alreadyIssued": 0, "imported": 0, "refunded": 3
    }
  ]
}
```

Se a key não tiver as permissões de leitura, vem `"pastSales": { "warning": "A API key do AbacatePay precisa da(s) permissão(ões) CHECKOUT:READ" }`. Nesse caso, mostre o aviso com o botão "Atualizar key". A conexão em si **funcionou**.

## 3. Tela nova: "Vendas sem nota"

Mostre logo **depois da etapa 4**, como etapa opcional "4.1", e também como um **cartão no painel**. Use `GET /v1/app/companies/{tenantId}/past-sales` → `{ periods: [...] }`.

**Título:** "Encontramos vendas sem nota fiscal"

**Um card por mês** (`periods`, do mais recente para o mais antigo):

- Mês por extenso ("outubro/2026"), `available.count` vendas e `available.totalCents` formatado em R$.
- Custo da emissão: `available.count × pricePerInvoiceCents` (de `GET /v1/public/pricing`), por exemplo "Emitir 47 notas custa R$ 37,60".
- Se `alreadyIssued`, `imported` ou `refunded` forem maiores que zero, mostre em letra pequena: "12 já emitidas · 3 estornadas (não entram)".
- Se `available.withoutItems > 0`: "2 vendas por Pix avulso sem produto. Escolha um produto para elas", com um select de produtos (`GET /v1/app/companies/{tenantId}/products`) que vira `fallbackProductId`.

**Botão "Revisar vendas"** em cada card:

- Abre a lista de `GET /v1/app/companies/{tenantId}/past-sales/items?period=2026-10&status=AVAILABLE,ALREADY_ISSUED`.
- Colunas: data (`paidAt`), cliente (`customer.name` ou "Cliente não identificado"), valor (`amountCents`) e um checkbox **"Já tem nota em outro sistema"**.
- Marcar ou desmarcar chama `POST /v1/app/companies/{tenantId}/past-sales/mark` com `{ "ids": ["…"], "alreadyIssued": true }` (ou `false`).
- Atalho no topo: "Marcar o mês inteiro como já emitido", que envia `{ "period": "2026-10", "alreadyIssued": true }`.

**Botão "Emitir N notas"** em cada card:

- **Mês atual** (`requiresConfirmation: false`): chama direto `POST /v1/app/companies/{tenantId}/past-sales/issue` com `{ "period": "2026-10", "fallbackProductId": "…opcional" }`.
- **Mês anterior** (`requiresConfirmation: true`): abra um modal de confirmação **obrigatório** com o texto:
  > "Essas vendas são de setembro/2026. A nota sai com a competência de setembro. Se você é do Simples Nacional e essa receita não entrou no DAS de setembro, seu contador vai precisar retificar a declaração (pode haver multa e juros). Recomendamos confirmar com seu contador antes."
  - Use um checkbox "Entendi e quero emitir" e o botão "Emitir". Envie `{ "period": "2026-09", "confirmPastPeriod": true }`.
- **Resposta:** `{ "issued": 45, "held": 2, "skippedWithoutProduct": 0, "failed": [] }`. Mostre:
  - "45 notas entrando na fila de emissão."
  - Se `held > 0`: "2 aguardam você definir a tributação do produto no assistente; saem automaticamente depois."
  - Se `failed` não estiver vazio: liste `failed[].message`.

**Rodapé da tela:**

- "Agora não": pula a etapa.
- "Atualizar lista": `POST /v1/app/companies/{tenantId}/past-sales/scan` com `{ "monthsBack": 3 }` (máximo 12), para buscar de novo no AbacatePay.

## Referência rápida

| Método | Rota                                                      | Uso                                                       |
| ------ | --------------------------------------------------------- | --------------------------------------------------------- |
| POST   | `/v1/app/companies/{id}/past-sales/scan`                  | Busca de novo no AbacatePay (`monthsBack` 0–12, padrão 3) |
| GET    | `/v1/app/companies/{id}/past-sales`                       | Prévia por mês                                            |
| GET    | `/v1/app/companies/{id}/past-sales/items?period=&status=` | Vendas de um mês                                          |
| POST   | `/v1/app/companies/{id}/past-sales/mark`                  | `{ ids?, period?, alreadyIssued }`                        |
| POST   | `/v1/app/companies/{id}/past-sales/issue`                 | `{ period, confirmPastPeriod?, fallbackProductId? }`      |

## Como conferir

1. Conectar o AbacatePay mostra a prévia com o mês atual e os anteriores. Vendas estornadas e pendentes não aparecem como disponíveis.
2. Marcar uma venda como "já tem nota" faz o card descontar essa venda.
3. Emitir o mês atual não pede confirmação. Emitir um mês anterior **sem** o checkbox mostra o erro 422 com o aviso do PGDAS; com o checkbox, emite.
4. Emitir o mesmo mês de novo não duplica nada: as vendas já viram `imported`.
