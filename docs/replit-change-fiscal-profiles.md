# Mudança na API do açaínfe: "O que você vende?" e perfis fiscais

**Para o Replit Agent.** O app já está no ar. Aplique **somente** as alterações abaixo.

## O que é

O usuário não é contador. Em vez de ele escolher código de serviço produto a produto, o app pergunta **"O que você vende?"** e o açaínfe aplica a tributação padrão:

- **Infoprodutor** (cursos, treinamentos, mentorias): perfil validado. Os produtos já saem prontos para vender.
- **MicroSaaS** (assinaturas de software): perfil ainda em validação. Os produtos chegam com uma **sugestão**, e o usuário confirma cada um com um clique.

A resposta é obrigatória: enquanto ela faltar, `readiness.missing` contém `businessType` e as vendas ficam retidas.

## 1. Etapa 3: pergunta "O que você vende?"

Mostre a pergunta quando `readiness.missing` contiver o field `businessType`. Ela vem **antes** da pergunta da numeração.

- **Opções:** `GET /v1/app/fiscal-profiles` devolve:
  ```json
  [
    { "businessType": "INFOPRODUCER", "label": "Infoprodutor", "examples": "Cursos, treinamentos, mentorias", "validated": true },
    { "businessType": "MICROSAAS", "label": "MicroSaaS", "examples": "Assinaturas e licenças de software", "validated": false }
  ]
  ```
  Mostre dois cards grandes com `label` e `examples`. Não mostre os códigos fiscais.
- **Ao escolher:** envie junto com o resto da etapa, no `PATCH /v1/app/companies/{tenantId}` que já existe:
  ```json
  { "businessType": "INFOPRODUCER", "issuesElsewhere": false }
  ```
- **Texto de ajuda** abaixo dos cards: "Usamos isso para preencher a tributação dos seus produtos. Você pode revisar depois."

## 2. Alíquota de ISS (só quando a API pedir)

Para quem está no Simples, a alíquota é calculada sozinha. Fora do Simples, o açaínfe consulta a prefeitura. Se ela não publicar o dado, `readiness.missing` traz o field `issRateBps`.

- **Quando mostrar:** só se `readiness.missing` contiver `issRateBps`. Nunca mostre o campo em outro caso.
- **Campo:** "Alíquota de ISS do seu município (%)", com a `message` da API como texto de ajuda.
- **Conversão:** use `percentToBps` (do documento dos inteiros). Aceite de 2 a 5%: `bps` entre `200` e `500`. Fora disso, mostre "Informe entre 2% e 5%, ex.: 2 ou 2,5".
- **Envio:** `PATCH /v1/app/companies/{tenantId}` com `{ "issRateBps": 250 }`.
- **Exibição** nos dados da empresa: `tenant.effectiveIssRateBps` (formate com `bpsToPercent`). Pode ser `null`.

## 3. Etapa 4 (AbacatePay): resposta ganhou campos

`POST /v1/app/companies/{tenantId}/abacatepay` agora devolve também:

```json
{
  "imported": 3,
  "confirmedByProfile": [{ "id": "…", "name": "Curso de Vendas" }],
  "pendingTaxReview": [],
  "skippedTestProducts": ["Produto Teste"],
  "mergedDuplicates": [{ "name": "Kero Avaliar", "externalId": "prod_xyz", "productId": "…" }]
}
```

Troque o resumo da etapa por:

- `confirmedByProfile.length > 0`: "✓ N produtos importados e prontos para vender."
- `pendingTaxReview.length > 0`: "N produtos aguardam sua confirmação" e um link para a tela de produtos (item 4).
- `skippedTestProducts.length > 0`, em letra pequena: "Ignoramos produtos de teste: Produto Teste."
- `mergedDuplicates.length > 0`, em letra pequena: "Kero Avaliar aparecia duas vezes no AbacatePay; juntamos em um só produto."

## 4. Tela de produtos

`GET /v1/app/companies/{tenantId}/products` agora devolve cada item com `warnings` (lista de textos).

**Produto com `taxStatus: "PENDING_REVIEW"` e `suggestedTaxProfile`:**

- Mostre "Tributação sugerida" e o botão **"Confirmar"**.
- O botão chama `POST /v1/app/companies/{tenantId}/products/{productId}/confirm-tax` com:
  ```json
  { "userConfirmed": true }
  ```
- **Não envie `via`** nem nenhum valor fixo de teste. A API registra que a confirmação veio do app.
- **Resposta:** `{ product, releasedHeldSales }`. Se `releasedHeldSales > 0`, mostre "N vendas retidas viraram nota."

**Produto com `warnings`:** mostre cada texto em amarelo abaixo do nome. Um produto sem NBS **não pode ser vendido**, e o texto da API já explica o que informar.

**Botão "Novo produto":** um formulário com nome, descrição e preço (`defaultPriceCents`). Ele chama `POST /v1/app/companies/{tenantId}/products` com `{ "name": "…", "serviceDescription": "…", "defaultPriceCents": 9700 }`, **sem** `taxProfile`. A API aplica o perfil da empresa e devolve o produto já com `taxStatus` e `warnings`.

## 5. Selo "Modo teste"

Se `tenant.environment === "HOMOLOGATION"`, mostre no topo do painel um selo cinza: **"Modo teste: as notas não têm valor fiscal e não são cobradas."**

## Referência rápida

| Método | Rota                                                         | Uso                                   |
| ------ | ------------------------------------------------------------ | ------------------------------------- |
| GET    | `/v1/app/fiscal-profiles`                                    | Opções de "O que você vende?"         |
| PATCH  | `/v1/app/companies/{id}`                                     | Agora aceita `businessType` e `issRateBps` |
| GET    | `/v1/app/companies/{id}/products`                            | Itens com `warnings`                  |
| POST   | `/v1/app/companies/{id}/products`                            | Novo produto (perfil aplicado)        |
| POST   | `/v1/app/companies/{id}/products/{productId}/confirm-tax`    | `{ userConfirmed: true }`             |

## Como conferir

1. Empresa nova no Simples em SBC: depois do certificado, `missing` = `["numbering", "businessType"]`.
2. Escolher **Infoprodutor** e "Não, vou começar agora": `canIssue` vira `true` e `tenant.effectiveIssRateBps` = `201` (2,01%).
3. Conectar o AbacatePay com um produto chamado "Teste": ele aparece em "Ignoramos produtos de teste" e não entra na lista.
4. Escolher **MicroSaaS**: os produtos importados aparecem com "Confirmar". Confirmar libera o produto e as vendas retidas.
5. Nenhuma ocorrência de `via` no código do front.
