# Produto padrão do AbacatePay e pagamentos ignorados

**Para o Replit Agent.** A API do açaínfe ganhou duas coisas novas, e o app precisa mostrá-las.

## Regras

- Não invente campos nem rotas.
- O navegador nunca chama a API diretamente: todas as chamadas passam pelo backend do app, com `x-app-key` e os dados do usuário, como já é feito hoje.

## 1. Pergunta do produto padrão (etapa do AbacatePay)

**Por quê:** o Pix transparente do AbacatePay chega sem produto. Para emitir a nota, o açaínfe precisa saber de qual produto ela é. Ele decide nesta ordem:

1. os itens do pagamento;
2. o campo `metadata.productExternalId` do Pix;
3. o **produto padrão** da empresa.

Se nenhum existir, o pagamento não gera nota.

**Quando mostrar:** logo depois que a conexão com o AbacatePay der certo (`POST /v1/app/companies/{tenantId}/abacatepay`).

**De onde vêm os dados:** a resposta da conexão traz `defaultProduct`:

| Campo | O que é |
|---|---|
| `decided` | `true` se a pergunta já foi respondida |
| `productId` | o produto escolhido, ou `null` para "Nenhum" (sempre presente) |
| `suggestedProductId` | aparece quando só existe um produto; deixe-o pré-selecionado |
| `options` | lista de `{ id, name }` para escolher |

**Tela:**
- **Título:** "Quando um pagamento chegar sem produto, qual produto vai na nota?"
- **Opções:** um botão de escolha para cada item de `options`, mais a opção **"Nenhum: esses pagamentos não geram nota"**.
- **Texto de apoio:** "Pix transparente do AbacatePay não informa o produto. Se você vende só um produto, escolha-o. Se vende vários, escolha 'Nenhum' e peça ao seu sistema para enviar o produto no Pix, em metadata.productExternalId. Atenção: com um produto padrão, todo Pix sem produto vira nota, inclusive pagamentos de teste."
- **Salvar:** `PUT /v1/app/companies/{tenantId}/abacatepay/default-product`.
  - Corpo: `{ "productId": "<id>" }`, ou `{ "productId": null }` para "Nenhum".
  - A resposta é a situação da integração, com `defaultProduct: { decided, productId }`.
- **Se `decided` já vier `true`:** não pergunte de novo durante o onboarding.

## 2. Painel: bloco do AbacatePay e pendências

- **Dados:** `GET /v1/app/companies/{tenantId}` traz `abacatepay.defaultProduct: { decided, productId }`.
- **No bloco do AbacatePay:**
  - mostre "Produto padrão: <nome do produto>" ou "Produto padrão: nenhum";
  - inclua um botão **"Alterar"** que abre a mesma escolha da etapa 1;
  - para montar a lista, use a lista de produtos que o app já carrega.
- **Pendência:** enquanto não houver decisão, `readiness.recommended` traz um item com `field: "defaultProduct"` e uma `message`. Ele aparece no cartão "Complete quando puder", como os outros. Ao clicar, abra a escolha.

## 3. Vendas antigas: ignorar pagamentos que não são venda

**Por quê:** pagamentos de teste aparecem como vendas sem nota. Antes, a única opção era "já tem nota em outro sistema", que não é verdade nesse caso.

**Botão "Ignorar (não é venda)":**
- **Onde:** na tela de vendas antigas, ao lado de "Já tem nota em outro sistema". Vale por venda e pelo mês inteiro.
- **Ação:** abre um campo opcional de motivo (ex.: "pagamento de teste") e chama `POST /v1/app/companies/{tenantId}/past-sales/ignore`.
- **Corpo:** `{ "ids": [...] }` ou `{ "period": "AAAA-MM" }`, com `"ignored": true` e `"reason"` opcional.
- **Desfazer:** a mesma rota com `"ignored": false`.

**Status novo `IGNORED`:**
- Mostre como **"Ignorada"**, com o motivo (`ignoredReason`).
- Pode ser usado no filtro da listagem `GET .../past-sales/items?status=IGNORED`.

**Resumo por mês:** o resumo (`GET .../past-sales`) ganhou o campo `ignored` (quantidade). Mostre-o junto de "já emitidas" e "estornadas".

## Formato da resposta

Ao terminar, devolva:
- a lista de telas e componentes alterados;
- se algum campo esperado não veio da API, qual foi.
