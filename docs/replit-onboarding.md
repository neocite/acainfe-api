# açaínfe: landing page e app de onboarding (Replit)

Briefing para construir no Replit a **landing page** (`/`) e o **app de onboarding** (`/app`) do **açaínfe**. Pode ser colado direto no Replit Agent.

O açaínfe emite nota fiscal de serviço (NFS-e) automaticamente para quem vende pelo **AbacatePay**. A operação do dia a dia acontece pelo assistente de IA (MCP). O app só faz o **cadastro inicial**: login, certificado, dados da empresa, conexão com o AbacatePay e entrega da chave do MCP.

# Parte 1: Landing page (`/`)

Página pública, sem login, feita para converter quem vende pelo AbacatePay. Todos os botões de ação levam a `/app`, onde estão o login com Google e o wizard.

## Preço (configurável)

- **Oferta de lançamento:** **R$ 0,80 por nota emitida**. Sem mensalidade, sem adesão, sem plano anual, sem limite de notas.
- **Onde fica o preço:** o valor **não pode ficar fixo no texto**. Crie uma única constante de configuração, por exemplo `PRICE_PER_INVOICE_CENTS = 80`, em `config/pricing.ts` ou numa variável de ambiente `VITE_PRICE_PER_INVOICE_CENTS`. Todo lugar que mostra preço (hero, calculadora, comparativo, FAQ, meta tags) deve ler dessa constante.
- **Preço vigente:** a API expõe o preço em `GET {ACAINFE_API_URL}/v1/public/pricing`, que responde `{ "pricePerInvoiceCents": 80, "monthlyFeeCents": 0, ... }`. O backend do app pode ler esse endpoint (com cache de alguns minutos) e repassar o valor para a landing, usando a constante só como valor padrão caso a API não responda.
- **Exibição:** formate em BRL com `Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })`.
- **Selo:** mostre "Preço de lançamento" perto do valor.

## Referência de estilo (inspiração, não cópia)

O público é a comunidade do AbacatePay, então a landing deve **conversar na mesma língua**. Ela **não pode parecer** uma página do AbacatePay.

- **Tom de voz:** português brasileiro bem informal, com "você" e um pouco de humor. Frases curtas, direto ao ponto, sem jargão contábil. Pode cutucar com leveza o mercado de mensalidades ("sem essa de plano anual"). Sem emojis no texto corrido.
- **Padrão de headline:** começo simples e a recompensa destacada em cor ou fundo. Exemplo: "Nota fiscal emitida **sozinha**, a cada venda."
- **Mensagem central da página:** **"Não vendeu? Não pagou."** Os principais emissores cobram mensalidade (alguns, o ano adiantado), venda você ou não. No açaínfe, o custo da nota acompanha a receita: mês parado custa R$ 0. Toda a página deve reforçar essa ideia: **risco zero, custo proporcional às vendas**. O preço por nota é um argumento secundário.
- **Microcopy sob cada botão de ação:** "Sem mensalidade. Não vendeu, não pagou."
- **Identidade visual própria do açaínfe**, com tema açaí. **Não use** o verde-limão nem o teal do AbacatePay, nem a fonte Fustat.
  - Cores (defina como tokens CSS em `:root`):
    - `--acai-900: #2A0E2E` (roxo profundo, fundos escuros e texto forte)
    - `--acai-700: #4A1942` (roxo açaí, cor principal da marca)
    - `--acai-500: #7B2D6B` (destaques)
    - `--acai-100: #F4E8F1` (fundos suaves)
    - `--creme: #FFF8EE` (fundo principal)
    - `--manga: #FF9F1C` (botões de ação e destaques de headline)
    - `--folha: #2F9E5B` (sucesso e checks)
    - `--texto: #2B2230`, `--texto-suave: #6B5F70`
  - Tipografia (Google Fonts): **Bricolage Grotesque** nos títulos (peso 700, tracking levemente negativo) e **Inter** no corpo. Uma fonte manuscrita, como **Caveat**, só para anotações e setas desenhadas no hero.
  - Formas: cards com raio de 16px, botões em pílula (`border-radius: 999px`), muito espaço em branco, container de 1200px, sombra suave.
  - Imagens: tigela de açaí estilizada, de preferência ilustração vetorial; prints do fluxo; um balão de conversa mostrando o assistente de IA emitindo nota. Nada de banco de imagens genérico.
- **Mobile first:** precisa ficar perfeita em 375px de largura.
- **Modo escuro:** opcional. Se fizer, use fundo `--acai-900`.

## Seções, em ordem

### 1. Navegação

- **Esquerda:** logo "açaínfe" (wordmark em Bricolage Grotesque, com um grão de açaí no lugar do pingo do "í").
- **Links:** Como funciona · Só paga se vender · Preço · Comparativo · FAQ.
- **Direita:** "Entrar" (leva a `/app`) e o botão principal **"Começar grátis"**.

### 2. Hero

- **H1:** "Não vendeu? **Não pagou.**"
- **Subtítulo:** "Nota fiscal de serviço automática para quem vende no AbacatePay. Cada pagamento aprovado vira NFS-e, enviada ao seu cliente por e-mail e WhatsApp. Sem mensalidade: você só paga R$ 0,80 quando vende." O valor vem da constante.
- **Frase de apoio, em duas linhas lado a lado** (cards pequenos):
  - "Mês sem vendas → **R$ 0,00**"
  - "Mês de lançamento com 150 vendas → **R$ 120,00**" (`150 × PRICE_PER_INVOICE`)
  - Uma seta manuscrita (Caveat) aponta para o primeiro card com a anotação "nada de mensalidade!".
- **Botão de ação:** **"Começar grátis"**, com a microcopy padrão embaixo.
- **Prova lateral:** um card com o "print" de uma conversa de IA:
  - Usuário: "emite a nota do pedido da Maria".
  - Assistente: "Pronto! NFS-e nº 1234 emitida e enviada para maria@… ✅".

### 2.1 Só paga se vender (seção logo abaixo do hero, com fundo `--acai-100`)

- **Título:** "Mensalidade cobra até no mês que você **não vendeu nada**."
- **Texto:** "Quem vende por lançamento conhece: uma semana de vendas fortes e depois meses calmos. Quem está começando nem sabe se vai vender. Com mensalidade, você paga o ano inteiro. No açaínfe, você paga só nas notas que emitiu, porque a nota só existe quando a venda existe."
- **Três argumentos em cards:**
  - **Risco zero para começar:** "Lançou o primeiro produto? Não precisa assumir um custo fixo antes da primeira venda."
  - **Feito para lançamentos:** "Vendeu muito numa semana e pouco no resto do mês? Você paga pelo que vendeu, não por um plano."
  - **Custo proporcional:** "Numa venda de R$ 97, a nota custa menos de 1% do valor. Em mês fraco, a mensalidade pesa muito mais por venda."
- **Calculadora anual interativa** (o grande destaque da página):
  - **Seletor de perfil** com 3 presets e um modo personalizado. Cada perfil define as notas de cada um dos 12 meses:
    - **"Faço lançamentos"**: 2 meses com 150 notas e 10 meses com 5 notas (350 no ano).
    - **"Estou começando"**: 3 meses com 0 notas e 9 meses com 10 notas (90 no ano).
    - **"Vendo todo mês"**: 12 meses com 40 notas (480 no ano).
    - **"Personalizado"**: 12 barras ajustáveis, uma por mês (no celular, um campo numérico por mês num carrossel).
  - **Gráfico:** barras de notas por mês, com uma linha tracejada por cima marcando a mensalidade dos concorrentes, que é constante mesmo nos meses de barra baixa.
  - **Resultado:** "No ano, você pagaria **R$ 280,00** no açaínfe. No plano de entrada mais barato com mensalidade: **R$ 890,00**. Diferença: **R$ 610,00** no seu bolso."
  - **Regras de cálculo** (as mesmas da seção 7; use o mesmo array de configuração):
    - **açaínfe:** soma das notas do ano × `PRICE_PER_INVOICE`.
    - **Mensalistas:** soma, mês a mês, de `mensalidade + max(0, notas − incluídas) × nota extra`.
    - **Spedy (plano anual):** R$ 890 por ano para 1.800 notas, mais R$ 0,62 por nota acima disso.
    - Planos sem preço de nota extra publicado (Notazz, NFE.io acima de 250) ficam fora do cálculo nos meses em que o volume excede o pacote. Mostre "requer plano maior" em vez de inventar valor.
  - **Honestidade obrigatória:** se em algum cenário o açaínfe **não** for o mais barato no ano, mostre: "Com esse volume constante, um plano com mensalidade pode sair mais barato. Fale com a gente: temos condições para volume." Nunca mostre uma comparação falsa.
  - **Rodapé da calculadora:** a mesma nota de fontes e data da seção 7.

### 3. Como funciona (3 passos com ícones e uma linha ligando os passos)

1. **"Entre com o Google e envie seu certificado A1."** A gente descobre seu CNPJ, sua cidade e suas atividades sozinho.
2. **"Conecte o AbacatePay com uma chave."** Criamos o webhook e importamos seus produtos. Zero configuração manual.
3. **"Converse com a IA uma vez."** Ela te ajuda a definir como cada produto é tributado. Depois disso, cada venda vira nota sozinha.

### 4. Benefícios (grid de cards)

- **Nota diferente por produto:** "Curso, mentoria e consultoria têm códigos de serviço diferentes. A gente emite certo, item por item."
- **Prefeitura fora do ar? Problema nosso:** "A venda fica na fila e a nota sai assim que o sistema voltar. Sem nota perdida, sem nota duplicada."
- **Estornou? Cancelou:** "Reembolso no AbacatePay cancela a nota automaticamente."
- **Assinaturas também:** "Cada renovação gera a nota do mês."
- **Seu logo na nota:** "O PDF sai com a sua marca."
- **Opera pelo seu assistente de IA:** "Emita, consulte, reenvie e cancele conversando. Funciona com Claude e outros clientes MCP."

### 5. Para quem é

Chips com os perfis: Infoprodutores · Mentores · SaaS e micro-SaaS · Agências · Consultores · Prestadores de serviço.

Explique a regra de disponibilidade de forma honesta: "Começamos por **São Bernardo do Campo (SP)** para empresas do **Simples Nacional e MEI**. Sua cidade ainda não está liberada? Cadastre-se mesmo assim: você entra na lista de espera e a gente te avisa por e-mail e WhatsApp assim que liberar."

### 6. Preço

- Um card central bem grande: **"R$ 0,80 por nota"** (lido da constante), com o selo "Preço de lançamento".
- Lista de checks: Sem mensalidade · Sem taxa de adesão · Sem plano anual · Sem limite de notas · Envio por e-mail e WhatsApp incluso · Cancelamento e estorno inclusos · Acesso pelo MCP incluso.
- Linha final, em destaque: "Emitiu 0 notas no mês? **Pagou R$ 0.**"

### 7. Comparativo

- **Título:** "Mensalidade é coisa do passado."
- **Duas abas:** **"No ano"** (padrão, aberta) e **"Por mês"**.
- **Aba "No ano"**, com o subtítulo "Um ano típico de quem faz lançamentos (2 meses com 150 vendas e 10 meses com 5 vendas, 350 notas no total):"

| Plataforma (plano de entrada)           | Custo no ano  | Diferença para o açaínfe |
| --------------------------------------- | ------------- | ------------------------ |
| **açaínfe**                             | **R$ 280,00** | —                        |
| Spedy Essencial (anual, pago adiantado) | R$ 890,00     | +R$ 610,00               |
| Focus NFe Solo                          | R$ 1.149,80   | +R$ 869,80               |
| eNotas Basic                            | R$ 1.782,60   | +R$ 1.502,60             |
| NFE.io Base                             | R$ 2.280,00   | +R$ 2.000,00             |

- Calcule esta tabela a partir do array de configuração e do perfil "Faço lançamentos". Os números acima servem para conferência.
- O Notazz fica fora da aba anual, porque não publica preço de nota extra acima de 100 notas/mês.

- **Aba "Por mês"**, com o subtítulo "Quanto você pagaria em um mês em cada plano de entrada:"
- **Tabela:** use **exatamente** estes dados. Guarde-os num array de configuração para facilitar a atualização e calcule as células a partir dele.

| Plataforma (plano de entrada) | Mensalidade                                 | Notas incluídas | Nota extra | 10 notas/mês | 50 notas/mês | 100 notas/mês |
| ----------------------------- | ------------------------------------------- | --------------- | ---------- | ------------ | ------------ | ------------- |
| **açaínfe**                   | R$ 0                                        | —               | R$ 0,80    | **R$ 8,00**  | **R$ 40,00** | **R$ 80,00**  |
| Spedy Essencial (plano anual) | R$ 74,00/mês (R$ 890 cobrados no ano)       | 1.800/ano       | R$ 0,62    | R$ 74,00     | R$ 74,00     | R$ 74,00      |
| Focus NFe Solo                | R$ 94,90                                    | 100             | R$ 0,11    | R$ 94,90     | R$ 94,90     | R$ 94,90      |
| Notazz Bronze                 | R$ 133,90 (+ adesão anunciada de R$ 133,90) | 100             | —          | R$ 133,90    | R$ 133,90    | R$ 133,90     |
| eNotas Basic                  | R$ 137,00                                   | 60              | R$ 0,77    | R$ 137,00    | R$ 137,00    | R$ 167,80     |
| NFE.io Base                   | R$ 190,00                                   | 250             | —          | R$ 190,00    | R$ 190,00    | R$ 190,00     |

- **Destaque visual:** a linha do açaínfe e a menor célula de cada coluna. Na coluna de 100 notas, a Spedy anual (R$ 74) é a mais barata: deixe isso visível, não esconda.
- **Rodapé obrigatório da tabela, em letra pequena e legível:** "Preços de entrada publicados nos sites oficiais de cada empresa, consultados em 19/10/2026: enotas.com.br/precos, nfe.io/precos, focusnfe.com.br/precos, spedy.com.br/precos e notazz.com. Valores sem impostos adicionais, cobrança mensal (Spedy: plano anual pago antecipadamente). Os planos têm recursos diferentes; compare antes de decidir. Para volumes acima de ~100 notas por mês, fale com a gente."
- **Botão abaixo da tabela:** "Quero parar de pagar mensalidade".
- **Regras:**
  - **Não** use frases absolutas como "o mais barato do Brasil" ou "mais barato que todos".
  - Use "sem mensalidade", "não vendeu, não pagou" e "mais barato para quem vende de forma irregular ou está começando".
  - Ao falar de concorrentes em geral, escreva "os principais emissores cobram mensalidade", e não "todos".
  - Use os nomes das empresas só no comparativo, sem logos de terceiros.

### 8. Integração com o AbacatePay

- **Texto:** "Feito para quem vende pelo AbacatePay: pagamento aprovado, nota emitida."
- **Logo do AbacatePay:** pode aparecer, usando o arquivo oficial de abacatepay.com/design, sem alterar cores ou proporções.
- **Proibido:** escrever "parceiro oficial", usar selo de certificação ou qualquer coisa que sugira parceria. As diretrizes de marca do AbacatePay proíbem isso sem autorização.
- **Grafia:** "AbacatePay", sem espaço.

### 9. FAQ (acordeão)

- **"Preciso de certificado digital?"** Sim, o A1 (arquivo .pfx), o mesmo usado no e-CAC. Ele fica criptografado e só serve para assinar suas notas.
- **"Minha cidade já é atendida?"** Começamos por São Bernardo do Campo (Simples Nacional e MEI). Cadastre-se para entrar na lista de espera da sua cidade.
- **"Preciso entender de imposto?"** Não. O assistente explica cada escolha em português claro e você só confirma. Na dúvida, mostre ao seu contador: tudo fica registrado.
- **"E se a prefeitura sair do ar?"** A nota entra na fila e sai sozinha quando o sistema voltar.
- **"Posso cancelar uma nota?"** Pode, pelo assistente. Reembolsos no AbacatePay cancelam a nota automaticamente.
- **"E se eu não vender nada no mês?"** Você não paga nada. Não existe mensalidade, adesão nem plano: a cobrança é só por nota emitida.
- **"Como sou cobrado?"** R$ 0,80 (constante) por nota emitida com sucesso. Notas rejeitadas pela prefeitura não são cobradas.
- **"Vocês são do AbacatePay?"** Não. O açaínfe é um produto independente, feito para quem vende pelo AbacatePay.

### 10. Chamada final

- **Fundo:** `--acai-900`, com texto creme.
- **Título:** "Você chegou até aqui. **Não vendeu, não pagou. Vendeu, a nota já foi.**"
- **Botão:** **"Começar grátis"**.

### 11. Rodapé

- Links: Termos de uso · Política de privacidade · Contato.
- Texto: "açaínfe — emissão de NFS-e sem mensalidade."
- CNPJ da empresa operadora. Deixe um placeholder `[CNPJ]` para eu preencher.
- Aviso: "O açaínfe não é afiliado ao AbacatePay."

## SEO e compartilhamento

- `<title>`: "açaínfe: nota fiscal automática, sem mensalidade, para quem vende no AbacatePay".
- Meta description: "Não vendeu? Não pagou. NFS-e automática a cada venda no AbacatePay, por R$ 0,80 por nota, sem mensalidade." O valor vem da constante.
- Open Graph com imagem 1200×630: tigela de açaí, a frase "Não vendeu? Não pagou." e o preço por nota.
- Domínio: `açaínfe.com` (em configuração use o punycode `xn--aanfe-yra7b.com`).

# Parte 2: App de onboarding (`/app`)

## Arquitetura (obrigatória)

```
Navegador ──► Backend do app (Replit, Express) ──► API açaínfe (https://flowing-rabbit-still.ngrok-free.app) - guardar isso pois vai mudar
              • Replit Auth (login com Google)
              • guarda ACAINFE_APP_KEY em Secrets
```

- **Login:** use o **Replit Auth** com Google.
- **Quem chama a API:** o **navegador nunca chama a API do açaínfe diretamente**. Toda chamada passa por rotas do backend do app (ex.: `/api/...`). O backend acrescenta estes headers:
  - `x-app-key`: o valor do Secret `ACAINFE_APP_KEY`. Nunca envie isso ao navegador.
  - `x-user-id`: o id estável do usuário no Replit Auth (claim `sub`).
  - `x-user-email`: o e-mail do usuário logado.
  - `x-user-name`: o nome, com `encodeURIComponent`.
- **Secrets do Replit:**
  - `ACAINFE_API_URL=https://flowing-rabbit-still.ngrok-free.app`
  - `ACAINFE_APP_KEY`
- **Erros:** a API responde `{ "error": "<CODIGO>", "message": "<texto em português>", "details"? }`. Mostre `message` ao usuário.

| HTTP | Código                              | O que fazer                                               |
| ---- | ----------------------------------- | --------------------------------------------------------- |
| 401  | `UNAUTHORIZED`                      | Problema na app key ou na sessão: refaça o login          |
| 404  | `NOT_FOUND`                         | Recurso não existe ou não pertence ao usuário             |
| 409  | `INVALID_STATE` / `CONFLICT`        | Ação indisponível agora (ex.: empresa na lista de espera) |
| 422  | `VALIDATION`, `CERTIFICATE_INVALID` | Mostre a mensagem ao lado do campo                        |

## Telas (wizard com 5 etapas e barra de progresso)

Na entrada, depois do login, chame `GET /v1/app/me`.

- Se `companies` estiver vazio, comece na etapa 1.
- Se já houver empresa, use `companies[0]` para decidir a etapa:
  - `availability.status === 'WAITLIST'`: mostre a tela de lista de espera.
  - `readiness.canIssue === false`: vá para a etapa 3.
  - `tenant.integrations.abacatepay === false`: vá para a etapa 4.
  - Caso contrário: vá para a etapa 5.

### Etapa 1: Seus dados

- **E-mail:** exiba o e-mail do login, sem permitir edição.
- **Campos:** Nome e WhatsApp (com máscara `(11) 99999-9999`).
- **Ao salvar:** `PUT /v1/app/me` `{ "name": "...", "whatsapp": "(11) 99999-9999" }`.

### Etapa 2: Certificado digital A1

- **Campos:** upload do arquivo `.pfx` ou `.p12` e a senha do certificado.
- **Texto de ajuda:** "É o mesmo certificado que você usa para emitir notas ou acessar o e-CAC. Ele fica guardado criptografado e serve para assinar suas notas."
- **Ao enviar:** `POST /v1/app/onboarding/certificate` em **multipart** com os campos `file` e `password`.
- **Resposta 201:**

```json
{
  "company": {
    "legalName": "AÇAÍ DIGITAL LTDA",
    "tradeName": "Açaí Digital",
    "cityName": "Sao Bernardo Do Campo",
    "uf": "SP",
    "simplesNacional": true,
    "mei": false,
    "cnaes": [{ "code": "8599604", "description": "Treinamento...", "primary": true }]
  },
  "tenant": {
    "id": "…",
    "cnpj": "11222333000181",
    "taxRegime": "SIMPLES_NACIONAL",
    "status": "ACTIVE",
    "cityCode": "3548708"
  },
  "availability": { "status": "READY" },
  "readiness": {
    "canIssue": false,
    "missing": [
      { "field": "municipalRegistration", "message": "Informe a inscrição municipal (CCM)" }
    ]
  },
  "pendingTaxReview": 0
}
```

- **Depois do envio:** mostre um cartão com razão social, CNPJ formatado, cidade/UF e regime.
  - `availability.status === 'READY'`: mostre "✅ Sua cidade já está liberada!" e siga para a etapa 3.
  - `'WAITLIST'`: mostre a **tela de lista de espera** com `availability.reason`, por exemplo: "Ainda não emitimos em São Paulo/SP. Você está na lista e vamos te avisar por e-mail e WhatsApp assim que liberar." Não avance.
- Guarde `tenant.id` para as próximas etapas.

### Etapa 3: Dados que a Receita não informa

A única pergunta obrigatória é a de **numeração** (aparece em `readiness.missing`). CCM e alíquota do Simples são **opcionais**: vêm em `readiness.recommended` e ficam numa seção recolhida "Tenho esses dados agora (opcional)". Sem a alíquota, o açaínfe usa 6% como estimativa (só o valor aproximado da Lei 12.741). Sem o CCM, emite assim mesmo e só pede o número se a prefeitura exigir.

- **`municipalRegistration`:** "Inscrição municipal (CCM)". Ajuda: "Está no seu cadastro na prefeitura ou no alvará."
- **`simplesNacionalTaxRateBps`:** "Alíquota efetiva do Simples (%)". Ajuda: "Está no seu último DAS. Se não souber, peça ao seu contador."
  - **Atenção à unidade:** a API recebe **inteiros em pontos-base** (centésimos de %). O usuário digita "6,25" e o front envia `625`; digitou "6" → `600`.
  - **Conversão:** faça só com inteiros, por texto: troque a vírgula por ponto, separe a parte inteira da decimal e componha `inteira × 100 + centésimos`. Não use `Math.round(parseFloat(x) * 100)`, porque o ponto flutuante dá erro em alguns valores.
  - **Na exibição:** volte para "6,25%".
  - **Dinheiro:** segue a mesma regra, sempre em centavos (R$ 82,20 = `8220`).
- **`numbering`:** sempre presente no primeiro acesso. Pergunta: "Você já emite nota fiscal de serviço por outro sistema (eNotas, portal da prefeitura, outro emissor)?" Duas opções:
  - **"Não, vou começar agora"**: envie `{ "issuesElsewhere": false }`.
  - **"Sim, já emito"**: envie `{ "issuesElsewhere": true }`. O açaínfe passa a usar uma **série exclusiva (900)**, o que evita repetir o número de uma nota que já existe.
  - Opção avançada, em "Prefiro informar a numeração": campos `dpsSeries` (série) e `nextDpsNumber` (próximo número livre). Ajuda: "Peça ao seu contador ou veja no seu emissor atual a série e o número da próxima nota."
- **Ajuste de regime:** se o regime vier errado, permita corrigir com um select `taxRegime` (`MEI`, `SIMPLES_NACIONAL`, `LUCRO_PRESUMIDO`, `LUCRO_REAL`).
- **Ao salvar:** `PATCH /v1/app/companies/{tenantId}` `{ "municipalRegistration": "123456", "simplesNacionalTaxRateBps": 600, "issuesElsewhere": true }`. A resposta tem o mesmo formato de status.
- **Para avançar:** quando `readiness.canIssue === true`, mesmo com itens em `readiness.recommended`.

### Etapa 3.1: Seu contador

Tela curta, logo depois dos dados da empresa.

- **Título:** "Quem é seu contador?"
- **Texto:** "Todo mês o seu contador precisa das notas emitidas. A gente manda **automaticamente, todo dia 1**, por e-mail e WhatsApp: os PDFs, os XMLs e a planilha no mesmo formato do eNotas. Você não precisa lembrar de nada."
- **Campos:** nome do contador ou do escritório (opcional), e-mail do contador e WhatsApp do contador. Peça pelo menos um dos dois contatos.
- **Ao salvar:** `PUT /v1/app/companies/{tenantId}/accountant` `{ "name": "...", "email": "...", "whatsapp": "(11) 99999-9999" }`.
- **Botão secundário:** "Não tenho contador agora", que pula a etapa. Mostre um lembrete no painel depois.
- Essa etapa **não bloqueia** a emissão.

### Etapa 4: Conectar o AbacatePay

- **Instrução:** "No painel do AbacatePay, crie uma API key com as permissões **PRODUCT:READ, WEBHOOK:CREATE, CHECKOUT:READ, TRANSPARENT:READ, SUBSCRIPTION:READ e CUSTOMER:READ**. As de leitura servem para encontrar vendas passadas sem nota; veja `replit-change-past-sales.md`." Coloque um link para https://app.abacatepay.com.
- **Campo:** API key.
- **Ao enviar:** `POST /v1/app/companies/{tenantId}/abacatepay` `{ "apiKey": "..." }`.
- **Resposta 201:**

```json
{
  "webhookId": "webh_…",
  "imported": 2,
  "alreadyExisting": 0,
  "pendingTaxReview": [{ "id": "…", "name": "Mentoria individual", "externalId": "prod_…" }]
}
```

- **Depois do envio:** mostre "Importamos N produtos" e a lista com o selo "aguardando definição do código de serviço". Explique: "Na próxima etapa, o assistente de IA vai te ajudar a definir, produto por produto, como cada serviço é tributado, com base nas atividades (CNAEs) da sua empresa. Vendas que chegarem antes disso ficam guardadas e viram nota assim que você confirmar."
- **Listagem depois:** `GET /v1/app/companies/{tenantId}/products?pendingTaxReview=true`.

### Etapa 5: Conectar o assistente (MCP)

- **Botão:** "Gerar minha chave". Chama `POST /v1/app/companies/{tenantId}/mcp-key`.
- **Resposta:**

```json
{
  "apiKey": "acai_…",
  "mcpUrl": "https://flowing-rabbit-still.ngrok-free.app/mcp",
  "claudeCodeCommand": "claude mcp add --transport http acainfe … --header \"Authorization: Bearer acai_…\""
}
```

- **Aviso:** "Guarde esta chave: ela é exibida uma única vez."
- **Exibição:** mostre `apiKey`, `mcpUrl` e o comando, cada um com botão de copiar, e uma aba de instruções para cada cliente:
  - **Claude Code:** o comando `claudeCodeCommand`.
  - **Claude Desktop / outros clientes:** adicionar um servidor MCP remoto (Streamable HTTP) com a URL `mcpUrl` e o header `Authorization: Bearer <apiKey>`.
- **Sugestão de primeira mensagem:** "Use o prompt **configurar_empresa** ou diga: 'quero definir a tributação dos meus produtos'."
- **Gerar de novo:** cria uma chave nova; as anteriores continuam válidas.

## Tela "Saldo" (cobrança do açaínfe)

Cada nota emitida custa o preço vigente. O saldo é avisado todo dia por e-mail e WhatsApp.

- **Consulta:** `GET /v1/app/companies/{tenantId}/billing` responde:
  ```json
  {
    "status": "OK",
    "openCents": 160,
    "openCharges": 2,
    "creditCents": 0,
    "amountDueCents": 160,
    "blocksAt": "2026-10-27T…",
    "overdue": false,
    "pricePerInvoiceCents": 80
  }
  ```
- **Cartão de saldo:** "Você tem **R$ 1,60** em aberto (2 notas). Pague até **27/10** para manter a emissão ativa."
- **Botão "Pagar com Pix":** chama `POST /v1/app/companies/{tenantId}/billing/payments`. A resposta traz `{ amountCents, pixCopyPaste, pixQrCodeImage, expiresAt }`. Mostre o QR Code (`pixQrCodeImage` é uma data URL) e o copia e cola com botão de copiar.
- **Emissão pausada (`status === 'BLOCKED'`):** mostre um banner vermelho fixo com o texto: "Emissão pausada por saldo em aberto. A emissão de nota fiscal é obrigatória: enquanto estiver pausada, você pode ficar em desacordo com a legislação. Suas vendas continuam registradas e as notas saem automaticamente assim que o pagamento for confirmado."
- **Crédito:** o Pix mínimo é R$ 1,00. A sobra vira crédito para as próximas notas; mostre `creditCents` quando for maior que 0.

## Painel (depois do onboarding)

Uma tela simples que usa `GET /v1/app/companies/{tenantId}` para mostrar:

- status da empresa;
- pendências (`readiness.missing`);
- número de produtos aguardando tributação (`pendingTaxReview`);
- validade do certificado.

## Referência rápida da API do app

| Método | Rota                                                    | Uso                                                                            |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/v1/app/me`                                            | Usuário e empresas (com status de cada uma)                                    |
| PUT    | `/v1/app/me`                                            | Nome e WhatsApp                                                                |
| POST   | `/v1/app/onboarding/certificate`                        | Multipart `file` + `password` (ou JSON `{pfxBase64, password}`)                |
| GET    | `/v1/app/companies/{id}`                                | Status: `availability`, `readiness`, `pendingTaxReview`                        |
| PATCH  | `/v1/app/companies/{id}`                                | `municipalRegistration`, `simplesNacionalTaxRateBps`, `taxRegime`, `tradeName` |
| POST   | `/v1/app/companies/{id}/abacatepay`                     | `{apiKey}`: cria o webhook e importa os produtos                               |
| POST   | `/v1/app/companies/{id}/mcp-key`                        | Gera a API key do MCP                                                          |
| PUT    | `/v1/app/companies/{id}/accountant`                     | Contador (e-mail/WhatsApp) para o envio mensal                                 |
| GET    | `/v1/app/companies/{id}/billing`                        | Saldo em aberto e data de pausa                                                |
| POST   | `/v1/app/companies/{id}/billing/payments`               | Gera o Pix do saldo                                                            |
| GET    | `/v1/app/companies/{id}/products?pendingTaxReview=true` | Produtos aguardando tributação                                                 |

O contrato OpenAPI completo fica em `GET /docs-json`, com a interface em `/docs`.

## Diretrizes de UX

- O público é PME e infoprodutor que vende pelo AbacatePay, e **não é contador**. Use linguagem simples e evite jargão: diga "código de serviço" em vez de cTribNac.
- A marca é **açaínfe**, com acento. Em URLs e configuração use o domínio em punycode (`acainfe.com`).
- Mobile first: o formulário precisa funcionar bem no celular.
