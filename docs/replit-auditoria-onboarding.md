# Auditoria do onboarding do açaínfe

**Para o Replit Agent.** O app já está no ar. **Não altere nenhuma tela ainda.** A tarefa é **conferir** se o onboarding coleta e envia tudo o que a empresa precisa para emitir nota fiscal, e **devolver um relatório**. As correções vêm depois, com base nele.

## Por que esta auditoria

A primeira nota real, emitida em São Bernardo do Campo, só saiu depois de vários ajustes feitos fora do app: numeração, o que a empresa vende, inscrição municipal, tributos aproximados e ambiente de produção. Precisamos saber o que o app já cobre e o que ficou de fora.

## Como conferir

Para cada item da lista abaixo:

1. Ache no código do app a tela ou o componente que trata o item.
2. Confira se a chamada à API usa a rota e o campo indicados, com o nome e a unidade exatos. Valores em dinheiro vão como inteiros em centavos (`Cents`) e percentuais como inteiros em pontos-base (`Bps`).
3. Se possível, faça o fluxo com uma empresa de teste. Depois de cada etapa, chame `GET /v1/app/companies/{tenantId}` e anote `readiness.missing` e `readiness.recommended`.
4. Classifique o item como **OK**, **PARCIAL** (existe, mas com campo, unidade ou texto errado) ou **AUSENTE**.

Não invente campos nem rotas. Se algo não existe na API, marque **AUSENTE** e explique.

## Checklist

### Etapa 1: perfil do usuário
| # | Item | Rota | Campo | Obrigatório |
|---|---|---|---|---|
| 1.1 | Nome | `PUT /v1/app/me` | `name` | sim |
| 1.2 | WhatsApp com DDD | `PUT /v1/app/me` | `whatsapp` | sim (recebe avisos de cobrança e de liberação) |

### Etapa 2: certificado A1
| # | Item | Rota | Observação |
|---|---|---|---|
| 2.1 | Arquivo `.pfx` e senha | `POST /v1/app/onboarding/certificate` (multipart `file` + `password`, ou JSON `{pfxBase64, password}`) | Mostra erro claro para senha errada, certificado vencido ou e-CPF |
| 2.2 | Resultado READY/WAITLIST | resposta: `availability.status` | WAITLIST mostra o motivo (`availability.reason`) e não deixa seguir |
| 2.3 | Dados da Receita | resposta: `company` (razão social, município, CNAEs, regime) | O usuário vê e confirma os dados |

### Etapa 3: dados que a Receita não informa
Rota: `PATCH /v1/app/companies/{tenantId}`.

| # | Item | Campo | Quando perguntar | Observação |
|---|---|---|---|---|
| 3.1 | O que você vende? | `businessType`: `INFOPRODUCER` ou `MICROSAAS` | sempre (`readiness.missing` traz `businessType`) | Opções em `GET /v1/app/fiscal-profiles` |
| 3.2 | Já emite por outro sistema? | `issuesElsewhere` (boolean) | sempre (`missing` traz `numbering`) | Se **sim**, o açaínfe usa a série exclusiva `900`. Confira se a tela explica isso |
| 3.3 | Inscrição municipal (CCM) | `municipalRegistration` | **ver nota A** | Hoje aparece em `recommended`. Em São Bernardo é obrigatória |
| 3.4 | Alíquota de ISS | `issRateBps` (200–500) | só se `missing` trouxer `issRateBps` | Converter "2,5" → `250` |
| 3.5 | Alíquota efetiva do Simples | `simplesNacionalTaxRateBps` | opcional (`recommended`) | Converter "6" → `600` |
| 3.6 | Regime tributário | `taxRegime` | só para corrigir o que a Receita trouxe | Presumido/Real não vêm da Receita |
| 3.7 | Tributos aproximados (IBPT) | — | **ver nota B** | A contabilidade exige o texto "Valor aprox dos tributos: R$ X. Fonte: IBPT" (15,53% para serviços) |

**Nota A (CCM):** a emissão em São Bernardo, pelo sistema da prefeitura (Ginfes), recusa a nota sem a inscrição municipal. Verifique se o app **pede o CCM** para empresas de São Bernardo do Campo (código IBGE `3548708`) ou se deixa passar porque ele vem em `recommended`. Relate o que acontece.

**Nota B (IBPT):** verifique se existe alguma tela para o percentual e o texto dos tributos aproximados. A API guarda isso em `approximateTaxes: { rateBps, descriptionTemplate }`, mas o `PATCH` do app **não aceita esse campo hoje**. Se não houver tela, marque AUSENTE.

### Etapa 4: AbacatePay
| # | Item | Rota | Conferir |
|---|---|---|---|
| 4.1 | Instrução das permissões da key | — | Lista as **6** permissões: PRODUCT:READ, WEBHOOK:CREATE, CHECKOUT:READ, TRANSPARENT:READ, SUBSCRIPTION:READ, CUSTOMER:READ |
| 4.2 | Título da tela | — | Não pode parecer que a conexão já foi feita ("Venda aprovada. Conexão feita." está errado) |
| 4.3 | Conectar | `POST /v1/app/companies/{tenantId}/abacatepay` | Corpo `{ apiKey, scanPastSales, monthsBack }` |
| 4.4 | Resumo dos produtos | resposta: `confirmedByProfile`, `pendingTaxReview`, `skippedTestProducts`, `mergedDuplicates` | Os quatro aparecem para o usuário |
| 4.5 | Aviso de key sem leitura | resposta: `pastSales.warning` | Aviso amarelo e botão "Atualizar key" |

### Etapa 4.1: vendas sem nota
| # | Item | Rota | Conferir |
|---|---|---|---|
| 4.6 | Prévia por mês | `GET .../past-sales` | Cards por mês com quantidade, total e custo |
| 4.7 | Cruzar com a prefeitura **antes** de emitir | `GET .../past-sales/reconcile?period=` e `POST .../past-sales/reconcile/apply` | O botão "Emitir" só aparece depois do cruzamento. Sem ele, a API recusa com mensagem sobre `reconcile_past_sales` |
| 4.8 | Marcar "já tem nota em outro sistema" | `POST .../past-sales/mark` | Por venda e pelo mês inteiro |
| 4.9 | Emitir | `POST .../past-sales/issue` | Meses anteriores exigem o modal de confirmação (`confirmPastPeriod: true`) |

### Etapa 5: MCP e extras
| # | Item | Rota | Conferir |
|---|---|---|---|
| 5.1 | Chave do MCP | `POST /v1/app/companies/{tenantId}/mcp-key` | Mostra a chave uma vez e o comando `claudeCodeCommand` |
| 5.2 | Contador | `PUT /v1/app/companies/{tenantId}/accountant` | `email` e/ou `whatsapp`, `dayOfMonth`. Recebe o pacote mensal |
| 5.3 | Produtos | `GET` e `POST .../products`, `POST .../products/{id}/confirm-tax` com `{ userConfirmed: true }` | Mostra `warnings` (produto sem NBS não vende) e **não envia `via`** |

### Depois do onboarding (painel)
| # | Item | Fonte | Conferir |
|---|---|---|---|
| 6.1 | Modo teste | `tenant.environment === "HOMOLOGATION"` | Selo "Modo teste: notas sem valor fiscal". **Ver nota C** |
| 6.2 | Pendências | `readiness.missing` / `readiness.recommended` | Cartão "Complete quando puder" com cada `message` |
| 6.3 | Notas aguardando aprovação | — | **Ver nota D** |
| 6.4 | Saldo e cobrança | `GET .../billing`, `POST .../billing/payments` | Pix do saldo em aberto |

**Nota C (produção):** toda empresa nova nasce em **homologação**, e as notas não têm valor fiscal. Verifique se existe algum caminho no app para **ativar a emissão real**. A API do app **não aceita `environment` hoje**. Se não houver caminho, marque AUSENTE: hoje isso só é feito fora do app.

**Nota D (modo piloto):** em São Bernardo, cada nota fica parada até alguém conferir a prévia e aprovar. Hoje isso só existe no MCP (`preview_invoice` / `approve_invoice`). Verifique se o app mostra notas com `lastErrors[0].code === "AWAITING_APPROVAL"`. A API do app **não tem rota de aprovação hoje**. Se não houver, marque AUSENTE.

## Fora do app (só registrar)

Estes itens não dependem do app, mas o relatório deve dizer se o app **orienta** o usuário sobre eles:
- **Cadastro na prefeitura (ISSSBC):** o regime "ME/EPP do Simples" e o e-mail e telefone do prestador vêm do cadastro municipal, e não do açaínfe.
- **Outro emissor (eNotas etc.):** ao começar a emitir pelo açaínfe, é preciso **desligar a emissão automática do outro sistema** para as vendas do AbacatePay, senão a nota sai em duplicidade.

## Formato da resposta

Devolva **um único relatório em Markdown**:

1. **Tabela** com uma linha por item (1.1 a 6.4, mais as notas A a D):

   | # | Item | Status (OK/PARCIAL/AUSENTE) | Onde no código | O que está diferente |
   |---|---|---|---|---|

2. **Ordem do fluxo:** a sequência de telas como está hoje, com o `readiness` observado depois de cada etapa, se você conseguiu rodar.
3. **Lacunas que dependem da API:** itens que não dá para corrigir só no front, como as notas A a D.
4. **Sugestões de texto:** só onde a tela confunde o usuário. Não implemente nada.
