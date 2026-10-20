# Menu "Gateways de pagamento"

**Para o Replit Agent.** Hoje a integração com o AbacatePay é um bloco dentro do Painel. Ela vai ganhar um menu próprio: **"Gateways de pagamento"**. Hoje só existe o AbacatePay, mas a tela deve estar pronta para receber outros gateways no futuro.

## Regras

- Não invente campos nem rotas. A API já tem tudo o que esta tela usa.
- As chamadas continuam saindo do backend do app, como hoje.
- A API key do AbacatePay nunca é exibida nem guardada pelo app. Ela só é enviada à API ao conectar.

## 1. Menu e Painel

- **Menu:** aba nova **"Gateways de pagamento"**, entre "Painel" e "Dados fiscais".
- **No Painel**, o bloco "Integração AbacatePay" vira um resumo de uma linha:
  - "AbacatePay conectado · webhook ativo", ou o aviso, se houver problema;
  - um link "Gerenciar", que abre o menu novo.

  O resto do bloco vai para o menu novo.

## 2. Página "Gateways de pagamento"

**Dados:** `GET /v1/app/companies/{tenantId}`, campo `abacatepay`:

| Campo | O que é |
|---|---|
| `connected` | se o AbacatePay está conectado |
| `connectedAt` | desde quando |
| `webhookEndpoint` | o endereço do webhook |
| `webhookUpToDate` | `true`, `false` ou `null` |
| `defaultProduct` | `{ decided, productId }` |

### Cartão "AbacatePay"

- **Status:**
  - "Conectado desde DD/MM/AAAA";
  - selo **"Webhook ativo"** quando `webhookUpToDate` for `true`;
  - aviso **"Webhook desatualizado"** quando for `false`;
  - nada quando for `null`.
- **Endereço do webhook:** `webhookEndpoint`, com botão "Copiar".
- **Produto padrão:** o nome do produto, ou "Nenhum (esses pagamentos não geram nota)", com o botão "Alterar". Use o mesmo modal de hoje (`PUT .../abacatepay/default-product`).
- **Ações:**
  - **"Atualizar API key":** abre um campo para a nova key e chama `POST /v1/app/companies/{tenantId}/abacatepay` com `{ "apiKey": "...", "scanPastSales": true }`.
    - Mostre o resumo da resposta: produtos importados, `pendingTaxReview`, `skippedTestProducts` e `mergedDuplicates`.
    - Explique: "Use quando a key mudou ou precisa de mais permissões. O webhook e o produto padrão continuam os mesmos."
  - **"Recriar webhook":** chama `POST /v1/app/companies/{tenantId}/abacatepay/webhook`, com corpo vazio ou `{ "apiKey": "..." }`.
    - Explique: "Use se as vendas pararam de chegar ou se o webhook estiver desatualizado. Depois, apague o webhook antigo no painel do AbacatePay."
    - Peça confirmação antes de chamar.
  - **"Vendas sem nota":** um link para a tela de vendas antigas que já existe (prévia por mês, cruzamento, ignorar e emitir).
- **Não conectado:** mostre o botão "Conectar AbacatePay", com o mesmo fluxo da etapa 4 do onboarding: as 6 permissões da key e a pergunta do produto padrão ao final.

### Cartão "Outros gateways"

- Um cartão discreto: "Em breve: outros gateways de pagamento. Quer usar outro? Fale com a gente."
- Sem botão funcional.

## 3. Aba "Configuração"

- Com este menu, a reconexão do AbacatePay deixa de depender da aba "Configuração".
- Atualize a regra do briefing anterior: só mantenha "Configuração" visível depois do onboarding se ainda houver algo que só existe lá.

## Formato da resposta

Ao terminar, devolva:
- as telas e os componentes alterados;
- o que ainda só existe na aba "Configuração", se houver.
