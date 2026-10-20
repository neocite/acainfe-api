# Mudança na API do açaínfe: percentuais agora são inteiros (pontos-base)

**Para o Replit Agent.** O app já está no ar. Aplique **somente** as alterações abaixo, sem refazer telas nem mexer em outras partes.

## O que mudou na API

A API agora só aceita e devolve **números inteiros**:

- **Dinheiro:** continua em **centavos**, sem mudança. R$ 82,20 = `8220` (campos terminados em `Cents`).
- **Percentuais:** passaram a ser **pontos-base** (centésimos de %), com campos terminados em `Bps`.
  - 6% = `600`
  - 6,25% = `625`
  - 2,01% = `201`
  - 15,53% = `1553`

Se a API receber um decimal (por exemplo `6.25`), ela responde **422** com `message` explicando a unidade.

### Campos renomeados que o app usa

| Antes                                                                                  | Agora                                    | Unidade     |
| -------------------------------------------------------------------------------------- | ---------------------------------------- | ----------- |
| `simplesNacionalTaxRate` (ex.: `6.25`)                                                 | `simplesNacionalTaxRateBps` (ex.: `625`) | pontos-base |
| `readiness.missing[].field === 'simplesNacionalTaxRate'`                               | `'simplesNacionalTaxRateBps'`            | —           |
| `tenant.simplesNacionalTaxRate` (respostas de `/v1/app/me` e `/v1/app/companies/{id}`) | `tenant.simplesNacionalTaxRateBps`       | pontos-base |
| `taxProfile.issRate` (lista de produtos)                                               | `taxProfile.issRateBps`                  | pontos-base |
| `taxProfile.approximateTaxRate`                                                        | `taxProfile.approximateTaxRateBps`       | pontos-base |

Rotas, nomes dos demais campos e formatos de resposta **não mudaram**. `pricePerInvoiceCents`, `openCents`, `amountDueCents` e `creditCents` continuam em centavos, como já estavam.

## Alterações no front

### 1. Funções utilitárias (criar em `client/src/lib/numbers.ts` ou equivalente)

Converta **por texto**, sem `parseFloat(x) * 100`. O ponto flutuante dá resultados errados em alguns valores: `0.29 * 100 = 28.999999999999996`.

```ts
/** "6", "6,25", "6.5", "15,53" → 600, 625, 650, 1553. Retorna null se inválido (mais de 2 casas, letras…). */
export function percentToBps(input: string): number | null {
  const v = input.trim().replace('%', '').replace(',', '.');
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** 625 → "6,25" (para exibir e para preencher inputs). */
export function bpsToPercent(bps: number): string {
  return `${Math.trunc(bps / 100)},${String(bps % 100).padStart(2, '0')}`;
}

/** 8220 → "R$ 82,20" (já devia estar assim; só confirme). */
export const formatCents = (cents: number): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
```

### 2. Etapa 3 do onboarding ("Dados que a Receita não informa")

- **Campo exibido:** continua **"Alíquota efetiva do Simples (%)"**, e o usuário digita como está acostumado: `6`, `6,25` ou `6,5`.
- **Pendência:** o campo aparece quando `readiness.missing` contiver o field **`simplesNacionalTaxRateBps`** (antes era `simplesNacionalTaxRate`).
- **Ao salvar:**
  ```ts
  const bps = percentToBps(form.simplesRate);
  if (bps === null || bps > 3300) {
    setError('simplesRate', 'Informe um percentual válido, ex.: 6 ou 6,25');
    return;
  }
  await api.patch(`/v1/app/companies/${tenantId}`, {
    municipalRegistration: form.municipalRegistration,
    simplesNacionalTaxRateBps: bps, // ← nome e unidade novos
    issuesElsewhere: form.issuesElsewhere,
  });
  ```
- **Ao reabrir a tela:** preencha o input com `bpsToPercent(tenant.simplesNacionalTaxRateBps)`, que mostra "6,25".

### 3. Onde o front exibe percentual

Troque a leitura e formate com `bpsToPercent(...) + '%'`:

- Dados da empresa: `tenant.simplesNacionalTaxRateBps`.
- Lista de produtos aguardando tributação, se mostrar alíquota: `taxProfile.issRateBps` e `taxProfile.approximateTaxRateBps`.

Procure no código por `simplesNacionalTaxRate`, `issRate` e `approximateTaxRate` sem o sufixo `Bps`. Nenhuma ocorrência deve sobrar.

### 4. Erros 422

Se a API responder 422 em `PATCH /v1/app/companies/{id}`, mostre `message` ao lado do campo, como já é feito nos outros erros. A mensagem já explica a unidade.

## Como conferir

| Usuário digita | Front envia                                    | Front exibe depois |
| -------------- | ---------------------------------------------- | ------------------ |
| `6`            | `600`                                          | `6,00%`            |
| `6,25`         | `625`                                          | `6,25%`            |
| `6,5`          | `650`                                          | `6,50%`            |
| `0,29`         | `29`                                           | `0,29%`            |
| `6,255`        | não envia: erro "Informe um percentual válido" | —                  |
| `abc`          | não envia: mesmo erro                          | —                  |

Depois de salvar a etapa 3, `GET /v1/app/companies/{id}` deve trazer `readiness.canIssue: true`, e `readiness.missing` não deve conter `simplesNacionalTaxRateBps`.

## Não mexer

- **Landing page e tela "Saldo":** `pricePerInvoiceCents`, `openCents`, `amountDueCents` e `creditCents` já eram centavos.
- **Demais etapas do wizard:** nenhum outro campo mudou.
