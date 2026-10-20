# Correção da etapa 4 (Conectar o AbacatePay)

**Para o Replit Agent.** Altere **somente** a tela da etapa 4. As outras telas ficam como estão.

## O que está errado hoje

1. **O título "Venda aprovada. Conexão feita." parece um status.** O usuário entende que a conexão já foi feita e pula a etapa.
2. **A lista de permissões está incompleta.** Faltam as permissões de leitura das vendas, e com a key criada desse jeito o açaínfe não consegue buscar os pagamentos antigos. O usuário teria que criar outra key depois.
3. **A tela não oferece buscar os pagamentos antigos sem nota.**

## Como a tela deve ficar

**Título:** "Conecte seu AbacatePay"

**Subtítulo:** "Com a conexão, cada venda aprovada vira nota fiscal automaticamente. Também buscamos as vendas que você já recebeu e que ainda estão sem nota."

**Instrução** (com as permissões em negrito, todas obrigatórias):

> No painel do AbacatePay, crie uma API key com as permissões **PRODUCT:READ**, **WEBHOOK:CREATE**, **CHECKOUT:READ**, **TRANSPARENT:READ**, **SUBSCRIPTION:READ** e **CUSTOMER:READ**.

Mantenha o link "Abrir painel do AbacatePay".

**Campo:** "Sua API key do AbacatePay", com o texto de ajuda: "Usada pelo servidor para criar o webhook, importar seus produtos e ler as vendas já recebidas. Fica guardada criptografada."

**Novo bloco: "Vendas antigas sem nota"**

- Checkbox marcado por padrão: **"Buscar vendas já recebidas que ainda não têm nota"**.
- Quando o checkbox estiver marcado, mostre um select **"Buscar desde"** com as opções:

  | Opção        | `monthsBack` |
  | ------------ | ------------ |
  | Este mês     | `0`          |
  | 3 meses      | `3` (padrão) |
  | 6 meses      | `6`          |
  | 12 meses     | `12`         |

- Texto pequeno abaixo: "Só mostramos uma prévia. Nada é emitido sem você confirmar."

**Botão:** "Conectar AbacatePay"

## Chamada

`POST /v1/app/companies/{tenantId}/abacatepay` com:

```json
{ "apiKey": "abc_...", "scanPastSales": true, "monthsBack": 3 }
```

Com o checkbox desmarcado, envie `{ "apiKey": "abc_...", "scanPastSales": false }`.

## Depois de conectar

- **Erro 422:** mostre `message` abaixo do campo da key. Ex.: "API key do AbacatePay inválida".
- **Sucesso:** mostre um resumo dos produtos, como já combinado: `confirmedByProfile`, `pendingTaxReview`, `skippedTestProducts` e `mergedDuplicates`.
- **`pastSales.periods` com algum mês em que `available.count > 0`:** vá para a tela "Encontramos vendas sem nota fiscal" (etapa 4.1 do documento de vendas passadas).
- **`pastSales.warning`:** a conexão funcionou, mas a key não tem as permissões de leitura. Mostre o texto em amarelo e o botão **"Atualizar key"**, que chama a mesma rota com a key nova. Reconectar não cria outro webhook.
- **Nenhuma venda antiga:** siga para a etapa 5.

## Como conferir

1. A tela lista as 6 permissões.
2. Uma key só com PRODUCT:READ e WEBHOOK:CREATE conecta, mas mostra o aviso amarelo com "Atualizar key".
3. Uma key completa com "3 meses" leva à tela de vendas sem nota quando há vendas pagas.
