# Mudança na API do açaínfe: CCM e alíquota do Simples ficaram opcionais

**Para o Replit Agent.** O app já está no ar. Aplique **somente** as alterações abaixo.

## Por quê

Quem cadastra de madrugada não sabe o CCM nem a alíquota do Simples, e não deve ficar travado esperando o contador acordar.

- **CCM (inscrição municipal):** no padrão nacional, a prefeitura já tem esse dado no cadastro nacional. O açaínfe emite sem ele e só pede o número se a prefeitura recusar a nota.
- **Alíquota do Simples:** é só o "valor aproximado dos tributos" que aparece na nota (Lei 12.741). Não muda o imposto pago no DAS. Enquanto o usuário não informar, o açaínfe usa **6%** como estimativa.

## O que mudou na API

A resposta de status (`readiness`, em `GET /v1/app/me`, `GET /v1/app/companies/{id}` e nas respostas das etapas) ganhou um campo novo:

```json
"readiness": {
  "canIssue": true,
  "missing": [],
  "recommended": [
    { "field": "municipalRegistration", "message": "Inscrição municipal (CCM): opcional. Se a prefeitura exigir, avisamos na primeira nota…" },
    { "field": "simplesNacionalTaxRateBps", "message": "Alíquota efetiva do Simples: usando 6% como estimativa… Ajuste quando souber." }
  ]
}
```

- **`missing`:** o que **impede** a emissão. Agora só pode conter `status`, `certificate` e `numbering`. `municipalRegistration` e `simplesNacionalTaxRateBps` **não aparecem mais aqui**.
- **`recommended`:** o que **não impede** a emissão e pode ser completado depois.

Nenhuma rota mudou. `PATCH /v1/app/companies/{id}` continua aceitando `municipalRegistration` e `simplesNacionalTaxRateBps`, agora opcionais.

## Alterações no front

### 1. Etapa 3 ("Dados que a Receita não informa")

- **Única pergunta obrigatória:** a de **numeração** ("Você já emite nota fiscal de serviço por outro sistema?"). Ela aparece quando `readiness.missing` contém `numbering`.
- **CCM e alíquota do Simples:** viram uma seção recolhida, **"Tenho esses dados agora (opcional)"**, com os dois campos.
  - Mostre cada campo só se ele estiver em `readiness.recommended`.
  - Abaixo de cada campo, use como texto de ajuda a própria `message` que vem da API.
  - **Botão principal:** "Continuar", que envia só o que foi preenchido. Exemplo: `{ "issuesElsewhere": false }` sozinho já basta.
  - A conversão de "6,25" para `625` continua igual à do documento anterior (`percentToBps`). Se o campo estiver vazio, **não envie** `simplesNacionalTaxRateBps`.
- **Para avançar:** quando `readiness.canIssue === true`, mesmo que `recommended` não esteja vazio.

### 2. Painel (depois do onboarding)

- **Cartão "Complete quando puder":** se `readiness.recommended` não estiver vazio, mostre uma linha por item com a `message` e um botão "Informar".
  - O botão abre um modal com o campo correspondente e salva via `PATCH /v1/app/companies/{id}`.
- **Cor:** o cartão é informativo (cinza/azul), não de erro. A empresa **já pode emitir**.

### 3. Onde mais o front olha `missing`

Procure no código por `missing` e por `municipalRegistration` / `simplesNacionalTaxRateBps`. Nenhuma lógica deve tratar esses dois campos como obrigatórios.

## Como conferir

1. Empresa nova, Simples, em São Bernardo: depois do certificado, `missing` = `["numbering"]` e `recommended` = `["municipalRegistration", "simplesNacionalTaxRateBps"]`.
2. Responder só "Não, vou começar agora" (`{ "issuesElsewhere": false }`): `canIssue` vira `true` e o wizard segue para a etapa do AbacatePay.
3. No painel, o cartão "Complete quando puder" aparece com os dois itens. Informar o CCM faz o item sumir.
