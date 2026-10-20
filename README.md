# açaínfe — API

> Marca: **açaínfe** (domínio `açaínfe.com`). Internamente o projeto se chama **acainfe** (pacote, banco, fila, prefixo das API keys `acai_`).
> Em URLs, DNS, certificados TLS e e-mail use a forma punycode do domínio: **`xn--aanfe-yra7b.com`**.

Emissor de NFS-e (Nota Fiscal de Serviço eletrônica) **AI-first**, multiempresa. Começa por **São Bernardo do Campo (IBGE 3548708)** e emite pelo **Sistema Nacional NFS-e** (Sefin/ADN). Desde 01/11/2026 esse é o padrão obrigatório para ME/EPP do Simples Nacional.

Diferenciais:

- **Tributação por produto.** Cada produto tem o próprio código de serviço (cTribNac), alíquota, retenção de ISS e IBS/CBS.
- **Divisão automática.** Uma venda com itens de tributações diferentes vira **várias NFS-e**, uma por perfil tributário.
- **Emissão assíncrona e resiliente.** Se a prefeitura cair, a venda é aceita mesmo assim (`202`). As retentativas usam backoff exponencial, há circuit breaker e o DPS é consultado antes de reenviar, para não emitir em duplicidade.
- **Entrega automática.** Assim que a nota é emitida, o DANFSe (PDF) segue por **e-mail** (Resend) e/ou **WhatsApp** (uazapi).
- **100% operável por MCP** em `/mcp`: por um agente de IA dá para configurar a empresa (dados, logo, AbacatePay, certificado), cadastrar produtos e clientes, emitir, acompanhar, explicar rejeições, reenviar, cancelar e estornar.
- **Logo da empresa no PDF** (DANFSe gerado por nós).
- **Estorno**: cancela na prefeitura as notas da venda. Notas que ainda não foram emitidas são encerradas sem emitir. Funciona pela API, pelo MCP ou automaticamente pelo evento de estorno do AbacatePay.
- **Clientes**: cadastro de tomadores. Vendas com dados novos cadastram o cliente automaticamente.

## Valores numéricos: sempre inteiros

Todo número persistido é inteiro:

- **Dinheiro em centavos:** R$ 82,20 = `8220` (campos `*Cents`).
- **Percentuais em pontos-base**, ou seja, centésimos de ponto percentual (campos `*Bps`):
  - ISS de 2,01% = `201`;
  - IBPT de 15,53% = `1553`;
  - Simples de 6% = `600`.
- **Quantidades:** também inteiras.

Os cálculos usam só aritmética inteira (`applyBps`). Os decimais aparecem apenas na saída: XML do DPS, PDF e planilha. Um teste e2e varre todas as coleções do MongoDB e falha se encontrar qualquer número não inteiro.

## Arquitetura (hexagonal)

```
src/
  domain/        entidades e regras puras (Tenant, Product/TaxProfile, Sale, Invoice, splitter, retry policy)
  application/
    ports/       interfaces: repositórios, FiscalProvider, Clock, EmailSender, WhatsappSender, JobScheduler...
    use-cases/   TenantService, CertificateService, ProductService, SaleService, InvoiceService
  adapters/
    in/
      http/      NestJS + Fastify, uma pasta por contexto (tenants, certificates, products, customers, sales,
                 invoices, past-sales, billing, accountant, public, webhooks, admin) + app/ (rotas do app web)
                 e shared/ (guards, erros, OpenAPI); index.ts lista os controllers
      mcp/       mcp-server.ts monta o servidor; tools/ tem um arquivo por contexto; instructions.ts e prompts.ts
      webhooks/  AbacatePay;  jobs/  workers do Agenda
    out/         mongo/, fiscal/nacional/ (DPS, XMLDSig, mTLS), fiscal/ginfes/ (ABRASF v3, SOAP), crypto/ (A1 + AES-GCM),
                 pdf/, email/, whatsapp/, scheduler/
  config/        env (Zod) e composition root (container.ts)
```

Um lint (`eslint.config.mjs`) garante as regras da arquitetura: `domain` não importa `application`/`adapters`, e nenhuma das duas camadas importa framework (Nest, Mongo, Agenda, MCP...).

### Fluxo de emissão

1. A venda chega por `POST /v1/sales`, pelo webhook do AbacatePay ou pela tool MCP `issue_invoice`. Ela é gravada de forma idempotente por `source + externalId`.
2. `splitSaleIntoInvoices` agrupa os itens por perfil tributário. Cada grupo recebe um número de DPS reservado atomicamente.
3. O job `issue-invoice` (Agenda, persistido no MongoDB) segue estes passos:
   - Assina o DPS (RSA-SHA256, C14N) com o A1 da empresa.
   - Envia para a Sefin via mTLS: `POST /nfse` com `{dpsXmlGZipB64}`.
   - O resultado é `ISSUED`, `REJECTED` (erro de negócio, com dicas), `RETRYING` (indisponibilidade) ou `FAILED` (esgotou ~5 dias de tentativas).
4. Com a nota `ISSUED`, os jobs `deliver-invoice` enviam o PDF por e-mail e/ou WhatsApp.
5. A cada 2 minutos, o job `reconcile-invoices` recupera notas travadas e reagenda pendências. Todos os dias às 9h, `certificate-expiry-warning` avisa sobre certificados perto do vencimento.

## Rodando

```bash
pnpm install
cp .env.example .env          # preencha ADMIN_API_KEY, MASTER_KEYS (openssl rand -base64 32), etc.
docker compose up -d mongo
pnpm start:dev                # http://localhost:3000/docs (Swagger) e /mcp
```

Produção: `docker compose up --build` (Dockerfile multi-stage, roda como usuário `node`).

### Onboarding self-service (app web no Replit)

O app de onboarding (Replit, login com Google pelo Replit Auth) usa as rotas `/v1/app/*`. O **backend** do app chama a API com `x-app-key` (`APP_API_KEY`) e a identidade do usuário (`x-user-id`, `x-user-email`). O fluxo:

1. Perfil: nome e WhatsApp.
2. Certificado A1: o açaínfe extrai o CNPJ, consulta a Receita (BrasilAPI) e devolve `READY` ou `WAITLIST`, conforme a cobertura do município e do regime.
3. Dados complementares: **"O que você vende?"** (`businessType`), numeração e, opcionais, inscrição municipal e alíquota do Simples.
4. Key do AbacatePay: o webhook é criado automaticamente e o catálogo é importado já com o perfil fiscal.
5. Key do MCP.

Produtos que ficam sem tributação confirmada (perfil não validado, ou empresa sem `businessType`) são confirmados pelo usuário no app (`confirm-tax`) ou **via MCP** (`list_pending_products` → `confirm_product_tax` com `userConfirmed: true`). Vendas que chegam antes disso ficam retidas e viram nota automaticamente depois da confirmação.

### Perfis fiscais padrão

A resposta de "O que você vende?" define a tributação padrão dos produtos (`src/domain/product/fiscal-profiles.ts`):

| `businessType` | cTribNac | Código local | NBS | IBS/CBS (CST / cClassTrib / cIndOp) | Situação |
| --- | --- | --- | --- | --- | --- |
| `INFOPRODUCER` (cursos, treinamentos, mentorias) | 080201 | 8.02/103911/1551 | 122051900 | 000 / 000001 / 100301 | Validado em 19/10/2026: confirma direto (`via: 'PROFILE'`) |
| `MICROSAAS` (assinaturas de software) | 010501 | — | 115062100 (SaaS) | 000 / 000001 / 100501 | **Não validado**: só sugestão; o usuário confirma cada produto |

- **Onde é aplicado:** na importação do AbacatePay, ao responder a pergunta (produtos pendentes) e na criação manual sem `taxProfile` (REST, MCP e app).
- **Alíquota de ISS:** não fica fixa no perfil. No Simples é estimada pela parcela do ISS no Anexo III (6% × 33,5% = 2,01% → `201`), limitada a 2%–5%. Fora do Simples vem da parametrização da prefeitura (ADN); se ela não publicar, `readiness.missing` pede `issRateBps`. No DPS ela só é enviada (`pAliq`) quando o ISS é retido.
- **NBS:** completado quando é inequívoco (mesmo código de um perfil validado ou única opção na tabela oficial). Sem NBS a **venda é bloqueada**. A tabela oficial de correlação (Anexo VIII v1.01) está em `nbs-correlation.data.ts`; `search_service_codes` devolve `nbsOptions` e `operationIndicators`, e NBS fora da tabela gera alerta.
- **Importação do AbacatePay:** produtos com cara de teste ("teste", "test", "demo", "sandbox", "homologação") não são importados (`skippedTestProducts`). Produtos com o mesmo nome viram um só, e o id extra vira `aliasExternalIds` (`mergedDuplicates`); vendas de qualquer um dos ids caem no mesmo produto.
- **Bloqueio de venda:** qualquer item de `readiness.missing` (exceto o certificado, que a fila de emissão espera) ou produto sem NBS segura a venda. Webhooks e vendas passadas ficam retidos e são liberados automaticamente quando a pendência some.

### Ginfes (São Bernardo do Campo) e modo piloto

São Bernardo do Campo ainda não liberou o Emissor Nacional para ME/EPP (rejeição E0039). Até liberar, essas empresas emitem pelo **Ginfes** (ABRASF v3, SOAP 1.1, TLS 1.2 com o A1 do prestador), em `src/adapters/out/fiscal/ginfes/`.

- **Roteamento:** `fiscalSystemFor` usa o `fiscalProvider` da empresa (`NACIONAL` ou `GINFES`, via `PATCH /v1/tenants/me` ou `update_company`). Sem ele, vale a regra do município: ME/EPP de cidades em `GINFES_CITIES` vão pelo Ginfes; MEI sempre vai pelo nacional. Para virar tudo para o nacional, use `GINFES_CITIES=none`.
- **Fluxo:** envia o lote (`RecepcionarLoteRpsV3`), acompanha a situação e busca a nota. Se o processamento demorar, a fila tenta de novo e, antes de reenviar, consulta pelo RPS (série/número da nota), que é a chave de idempotência.
- **Reforma tributária (layout 3.01), `GINFES_RTC_GROUPS` (padrão `nbs,trib,ibscbs`):** o formato segue uma NFS-e autorizada em SBC, emitida pelo eNotas (fixture anonimizada em `test/fixtures/ginfes/`).
  - `trib` e `IBSCBS` vêm logo depois de `IssRetido`. No fim de `Valores`, como no XSD do ACBr, a prefeitura recusou com E160.
  - `totTrib` vai como `pTotTrib` zerado; o percentual do IBPT vai no texto da discriminação.
  - No IBS/CBS, `cLocalidadeIncid` é o município do prestador e `vBC` é o valor do serviço. Por isso o grupo vai mesmo sem endereço do tomador.
  - `CodigoNbs` vem depois de `CodigoMunicipio`.
  - A validação usa `test/fixtures/xsd/ginfes/sbc`: o XSD do ACBr com a ordem de `tcValores` da produção.
- **Regime especial na nota:** o Ginfes monta a nota a partir do cadastro municipal. Se o cadastro não marca ME/EPP do Simples, a nota mostra "0-Nenhum" mesmo com `RegimeEspecialTributacao=6` no RPS. O ajuste é no cadastro do ISSSBC.
- **Campos:** `ItemListaServico` vem do código local ou nacional (`08.02`), e `CodigoTributacaoMunicipio` recebe o código local completo (`8.02/103911/1551`). A alíquota vai como fração (2,01% → `0.0201`). O CCM é obrigatório.
- **Assinatura:** RSA-SHA1 no `LoteRps` (`#Lote_n`). Nas consultas e no cancelamento, `URI=""`. O cancelamento usa o v3 e cai para o v2 se a prefeitura não reconhecer a estrutura.
- **Modo piloto** (`GINFES_PILOT=true`): cada nota fica `PENDING` com `AWAITING_APPROVAL` até o usuário conferir `preview_invoice` e chamar `approve_invoice`. `list_municipal_invoices` consulta as notas já emitidas na prefeitura, inclusive pelo eNotas.
- **Testes:** os XMLs são validados contra dois conjuntos de XSD (sped-nfse-ginfes e ACBr, em `test/fixtures/xsd/ginfes`), as assinaturas são verificadas, e o e2e usa um Ginfes falso que confere a assinatura.

### Homologação × produção

Vendas e notas guardam o `environment` da empresa no momento da venda.

- A idempotência é por ambiente: a mesma venda do AbacatePay pode ser emitida em homologação e, depois, de novo em produção.
- Notas de homologação **não são cobradas** e **não vão para o contador**.
- Vendas passadas importadas em homologação voltam a ficar disponíveis quando a empresa passa para produção.
- Na subida, `ensureIndexes` preenche o ambiente das vendas e notas antigas com o ambiente atual da empresa e troca o índice único de vendas.

- **Cobertura:** gerenciada em `PUT /v1/admin/coverage/:cityCode`. Ao liberar um município, as empresas da lista de espera são ativadas e avisadas por e-mail e WhatsApp.
- **Lista de espera:** `GET /v1/admin/waitlist`.
- **Briefing para o Replit:** [docs/replit-onboarding.md](docs/replit-onboarding.md).

**Campos opcionais no onboarding:** CCM e alíquota do Simples **não bloqueiam** a emissão (`readiness.recommended`).

- **Sem CCM:** o DPS sai sem `IM`, e a prefeitura usa o cadastro nacional. Se ela exigir (E0116), a nota é rejeitada com uma dica para informar o número.
- **Sem alíquota:** `pTotTribSN` usa 6% (`DEFAULT_SIMPLES_RATE_BPS`, 1ª faixa do Anexo III). É só o percentual aproximado da Lei 12.741; o imposto real é o do DAS.

### Onboarding manual (admin)

```bash
# 1. Cadastrar a empresa (admin) → devolve a apiKey uma única vez
curl -X POST localhost:3000/v1/tenants -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' -d '{
  "cnpj":"11222333000181","legalName":"Minha Empresa LTDA","municipalRegistration":"123456",
  "taxRegime":"SIMPLES_NACIONAL","simplesNacionalTaxRateBps":600,"email":"financeiro@empresa.com"}'

# 2. Enviar o certificado A1
curl -X POST localhost:3000/v1/certificates -H "x-api-key: $KEY" -F file=@certificado.pfx -F password=senha

# 3. Cadastrar produtos (cada um com sua tributação)
curl -X POST localhost:3000/v1/products -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"Suporte técnico","externalId":"prod_abc","taxProfile":{"nationalServiceCode":"010701"}}'

# 4. Emitir
curl -X POST localhost:3000/v1/sales -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{
  "externalId":"pedido-1","customer":{"name":"Maria","taxId":"52998224725","email":"maria@x.com","phone":"11999998888"},
  "items":[{"productExternalId":"prod_abc","totalCents":15000}]}'
```

Para o AbacatePay, chame `POST /v1/tenants/me/integrations/abacatepay`. A resposta traz a URL do webhook (com `webhookSecret`) para cadastrar no painel do gateway. O `externalId` do produto deve ser o id do produto no AbacatePay.

### Cobrança interna

- **Cobrança por nota:** cada NFS-e **emitida com sucesso** gera uma cobrança de `BILLING_PRICE_PER_INVOICE_CENTS` (hoje R$ 0,80). Notas rejeitadas não são cobradas. Dá para negociar o preço por empresa em `PUT /v1/admin/billing/:tenantId/price`.
- **Outbox:** a própria nota emitida serve de outbox. O job `charge-invoice` cobra na hora, a varredura do reconciliador (a cada 2 min) cobra o que ficou para trás, e um índice único por nota impede cobrança dupla.
- **Aviso diário (9h, horário de Brasília):** e-mail e WhatsApp com o saldo em aberto, o Pix copia e cola e a data em que a emissão será pausada.
- **Pagamento:** Pix gerado na conta AbacatePay do açaínfe (`POST /transparents/create`), confirmado pelo webhook `transparent.completed` em `/v1/webhooks/billing/abacatepay`.
  - O Pix mínimo é R$ 1,00. A sobra vira crédito e abate as próximas notas.
  - Pagamento fora do Pix gerado é registrado em `POST /v1/admin/billing/:tenantId/manual-payment`.
- **Pausa:** cobrança em aberto há mais de `BILLING_GRACE_DAYS` (7) dias **pausa a emissão**, e a empresa recebe um aviso sobre o risco legal.
  - As vendas continuam sendo registradas e as notas ficam na fila (`BILLING_BLOCKED`).
  - Quando o pagamento é confirmado, a emissão é retomada e as pendentes saem automaticamente.
- **Onde consultar:**
  - **Empresa:** `GET /v1/billing`, `GET /v1/billing/charges`, `POST /v1/billing/payments`.
  - **MCP:** `get_billing`, `list_billing_charges`, `pay_billing`.
  - **App:** `/v1/app/companies/:id/billing`.
  - **Landing:** `GET /v1/public/pricing`.
- **Pix transparente:** o Pix transparente chega sem itens. Quem gera o Pix informa o produto em `metadata.productExternalId`, e o webhook transforma o pagamento em venda desse produto pelo valor pago. Sem esse campo, o pagamento não gera nota.
- **Nota mensal do uso (receita do açaínfe):** a empresa que opera o açaínfe (`BILLING_INVOICE_ISSUER_CNPJ`) emite **uma NFS-e por cliente e mês**, com o total das notas emitidas no mês anterior. Regra validada pela contabilidade.
  - **O que entra no valor:** cobranças pagas ou em aberto. Notas canceladas depois também contam. Cobranças dispensadas (`WAIVED`) e de valor zero ficam de fora.
  - **Quando e com que dados:** o job `billing-monthly-invoices` roda todo dia às 7h e fecha o mês anterior, com competência no mês do uso. A nota usa o produto `BILLING_INVOICE_PRODUCT_EXTERNAL_ID` (item 1.05, NBS 1.1103.29.00, código SBC 1.05/102313/1234, ISS 2,01%, IBPT 15,56%), e o cliente (CNPJ, razão social, e-mail, endereço) é o tomador.
  - **Duplicidade:** a venda tem origem `ACAINFE_BILLING` e id `billing_<AAAA-MM>_<tenantId>`. Rodar de novo não duplica.
  - **Sem nota para si mesma:** a operadora não emite nota para ela mesma. O preço dela deve ser zero (`PUT /v1/admin/billing/:tenantId/price`), senão cada nota própria geraria uma cobrança a pagar a si mesma.
  - **Pix de cobrança:** o Pix de cobrança não traz produto, então o webhook AbacatePay da operadora não gera nota com ele. A nota sai pela nota mensal.
  - **Reprocessar um mês:** `POST /v1/admin/billing/monthly-invoices/:period`.
  - **Produto sem tributação:** se o produto não existir ou estiver sem tributação, a venda fica retida e vira nota quando for liberada.

### MCP

Endpoint Streamable HTTP em `/mcp`. Implementa a spec 2026-07-28 e aceita clientes 2025 em modo stateless. A autenticação usa a mesma API key da REST, em `Authorization: Bearer <apiKey>`. Exemplo para o Claude Code:

```bash
claude mcp add --transport http acainfe https://api.xn--aanfe-yra7b.com/mcp --header "Authorization: Bearer $KEY"
```

Tools disponíveis:

- **Empresa:** `get_company`, `update_company`, `set_company_logo`, `remove_company_logo`, `enable_abacatepay_integration`
- **Certificado:** `get_certificate_status`, `create_certificate_upload_link` (página segura, o .pfx não passa pela conversa), `upload_certificate` (base64)
- **Códigos de serviço:** `search_service_codes`, `get_municipal_rate`
- **Produtos:** `create_product`, `update_product`, `get_product`, `list_products`, `deactivate_product`
- **Clientes:** `create_customer`, `update_customer`, `get_customer`, `list_customers`, `delete_customer`
- **Vendas e notas:** `issue_invoice`, `get_sale`, `refund_sale`, `list_invoices`, `get_invoice`, `explain_invoice`, `retry_invoice`, `cancel_invoice`, `resend_invoice`

Prompts disponíveis: `configurar_empresa` (onboarding guiado) e `emitir_nota`.

### Numeração, emissores anteriores e tomador no exterior

- **Numeração:** quem já emite por outro sistema (eNotas, portal da prefeitura…) confirma isso no onboarding.
  - Com `issuesElsewhere: true`, o açaínfe usa a **série exclusiva 900**.
  - Também dá para informar série e próximo número livres (`PUT /v1/tenants/me/numbering` ou a tool MCP `set_invoice_numbering`).
  - Na mesma série a numeração nunca volta para trás, e série e número são reservados no mesmo update atômico.
- **Trava contra nota alheia:** a nota que a Sefin devolve para um DPS já existente só é aceita se **valor e tomador** baterem com a venda.
  - Se não baterem, a nota vai para REJECTED com o código `DPS_NUMBER_CONFLICT`.
  - O reprocessamento (`retry`) dá um **número novo** à nota.
- **Tomador no exterior:** `customer.foreign` (país ISO, NIF ou motivo da falta de NIF, endereço). O DPS sai com `NIF`/`cNaoNIF`, `endExt` e o grupo `comExt`, com padrões de serviço digital vendido em reais.
  - Por padrão a venda é **exportação de serviço** (`tribISSQN=3` com `cPaisResult`). Para tributar normalmente, use `foreignTreatment: 'TAXABLE'` no produto.
  - O IBS/CBS das vendas ao exterior vem de `foreignIbsCbs`.
- **Tributos aproximados (Lei 12.741):** configurados na empresa em `approximateTaxes`, como percentual simplificado em pontos-base (`rateBps`, ex.: IBPT 15,53% = `1553`) ou detalhado por esfera (`federalRateBps`, `stateRateBps`, `municipalRateBps`).
  - O valor aparece no PDF da nota.
  - Também pode ir na discriminação com um modelo de texto que aceita as tags `[ValorTributos]` e `[PercentualTributos]`.
  - Para empresas fora do Simples, o modo detalhado é enviado no DPS (`pTotTrib`).
- **Serviço padrão:** `defaultService` na empresa vira **sugestão** de tributação para os produtos importados do AbacatePay. O usuário ainda confirma cada um.
- **NBS:** produtos sem código NBS vêm com um aviso (`warnings`), e o assistente é instruído a sempre sugerir o NBS.
- **Preparação para o Ginfes (fase 2):** os campos `localServiceCode` (código municipal no formato livre, ex.: `8.02/103911/1551`) e `culturalIncentive` já são guardados. O adapter SOAP do Ginfes ainda não existe.

### Vendas passadas do AbacatePay (antes do açaínfe)

- **Prévia automática:** ao conectar o AbacatePay, o açaínfe lê checkouts, Pix avulsos e renovações de assinatura dos últimos meses (`/checkouts/list`, `/transparents/list`, `/subscriptions/checkouts/list`, mais `/customers/list` para os dados do tomador). Monta uma **prévia por mês** e não emite nada sozinho.
  - Permissões de leitura da key: `CHECKOUT:READ`, `TRANSPARENT:READ`, `SUBSCRIPTION:READ` e `CUSTOMER:READ`.
- **Vendas que já têm nota em outro sistema:** o usuário marca à mão para não emitir em duplicidade.
- **Estornos e contestações:** nunca entram.
- **Mês atual:** emite livremente.
- **Meses anteriores:** exigem `confirmPastPeriod`, porque a competência é retroativa e o contador pode precisar retificar o PGDAS.
- **Pix avulso sem itens:** usa um `fallbackProductId` escolhido pelo usuário.
- **Cruzamento com a prefeitura (Ginfes):** antes de emitir um mês, `reconcile_past_sales` compara as vendas disponíveis com as notas que a prefeitura já tem (ex.: emitidas pelo eNotas).
  - **Confiança HIGH:** mesmo valor e mesmo CPF/CNPJ.
  - **MEDIUM:** mesmo valor, mesmo nome e emissão entre 1 dia antes e 15 dias depois do pagamento.
  - **LOW:** só valor e data; é apenas informativo.
  - **O que fica de fora:** notas canceladas e notas emitidas pelo próprio açaínfe. Cada nota casa com uma venda só.
  - **Marcação:** `apply_past_sales_reconciliation` marca as vendas confirmadas como "já emitidas" e guarda o número da nota (`matchedNfse`).
  - **Bloqueio:** quando o provedor permite consultar a prefeitura, `issue_past_sales` recusa meses não cruzados, a menos que o usuário aceite o risco com `skipReconciliation: true`.
- **Sem duplicidade:** as vendas viram vendas normais com o mesmo id do AbacatePay, então um webhook atrasado não duplica nada. Produto sem tributação confirmada retém a venda até a confirmação.
- **Onde usar:** REST em `/v1/past-sales/*`, app em `/v1/app/companies/:id/past-sales/*` e MCP em `scan_past_sales`, `list_past_sales`, `mark_past_sales_already_issued` e `issue_past_sales`.
- **Reconectar o AbacatePay** (ex.: key com mais permissões) não cria outro webhook nem troca o segredo.

### Envio mensal ao contador

- **Cadastro:** `PUT /v1/tenants/me/accountant` (ou tool MCP `set_accountant`, ou app) com e-mail e/ou WhatsApp do contador. O dia do envio vem de `dayOfMonth` (padrão: dia 1).
- **O que vai, todo mês às 8h (Brasília):** o pacote do **mês anterior**.
  - **ZIP:** `pdf/` com os DANFSe (com o logo da empresa), `xml/` com as NFS-e e `notas-AAAA-MM.csv`.
  - **Planilha:** usa **exatamente o layout da "Planilha Notas Emitidas" do eNotas** (mesmo cabeçalho e separador `;`), para o contador manter a importação que já usa.
- **Canais:**
  - **E-mail:** leva a planilha e o ZIP (até 10 MB) mais um link assinado para baixar o pacote.
  - **WhatsApp:** leva o ZIP, pelo link.
  - A empresa recebe um aviso de que o envio foi feito.
- **Um envio por empresa e mês:** se falhar, o job tenta de novo no dia seguinte.
- **Envio manual e consultas:** reenvio ou antecipação em `POST /v1/tenants/me/accountant/reports {period}` (MCP `send_accountant_report`). Histórico em `GET /v1/tenants/me/accountant/reports`. Download direto em `GET /v1/tenants/me/accountant/packages/:period`.

### Estorno

- **REST:** `POST /v1/sales/:id/refund` ou `POST /v1/sales/by-external-id/:externalId/refund?source=API|MCP|ABACATEPAY`. Corpo opcional: `{reasonCode: '1'|'2'|'9', reason}`. O padrão é `2` (serviço não prestado).
- **Resultado por nota:**
  - `CANCELLED`: cancelada na Sefin.
  - `CANCELLED_BEFORE_ISSUE`: não tinha sido emitida.
  - `PENDING`: Sefin fora do ar; a fila conclui depois.
  - `FAILED`: a prefeitura recusou, por exemplo por prazo expirado. Exige ação manual.
- **AbacatePay:** os eventos `checkout.refunded`, `transparent.refunded` e `*.lost` (chargeback perdido) disparam o estorno automaticamente.

## Deploy (VPS com PM2)

1. **Uma vez, na máquina:** `sudo DOMAIN=api.acainfe.com EMAIL=voce@exemplo.com ./scripts/setup-server.sh`. Ele instala Node 22, pnpm e PM2, cria o site no nginx, emite o HTTPS (Let's Encrypt) e liga o PM2 na inicialização da máquina.
2. **Coloque o `.env`** na pasta do projeto, nunca pelo git:
   - `chmod 600 .env`;
   - `NODE_ENV=production`;
   - `PUBLIC_BASE_URL=https://api.acainfe.com`;
   - a **mesma** `MASTER_KEYS` de antes, porque os certificados A1 estão cifrados com ela.
3. **A cada atualização:** `./scripts/deploy.sh`.
   - Confere o `.env` sem exibir os valores, faz `git pull`, `pnpm install`, os testes e o build.
   - Recarrega no PM2 (`ecosystem.config.cjs`) e espera o `/health` responder.
   - Se a API não subir, volta sozinho para a versão anterior.
   - Use `SKIP_TESTS=1` para pular os testes e `BRANCH=...` para outra branch.

## Testes

```bash
pnpm test        # unitários (domínio, aplicação, adapters) — inclui validação do DPS assinado contra os XSDs oficiais v1.01
pnpm test:cov    # cobertura de domain/ e application/ (mínimo 80%)
pnpm test:e2e    # e2e: MongoDB real (mongodb-memory-server), Sefin fake via HTTP, fila Agenda real, REST, webhook e cliente MCP
pnpm lint && pnpm typecheck
```

Os XSDs oficiais do leiaute nacional (pacote `NFSe-ESQUEMAS_XSD-v1.01-20260209`) ficam em `test/fixtures/xsd/`.

## Pendências conhecidas e pontos a validar em homologação

- **Ainda não testado contra a Sefin real.** Precisa de um certificado A1 de um CNPJ de SBC habilitado no Sistema Nacional (produção restrita).
- **Pontos não confirmados na documentação oficial:**
  - se `GET /dps/{id}` usa o Id completo (com prefixo `DPS`);
  - o formato da competência na parametrização da ADN;
  - se SBC exige `IM` no DPS (configurável por empresa em `sendMunicipalRegistration`).
- **Ginfes (SBC, Lucro Presumido/Real) não implementado.** A porta `FiscalProviderResolver` já está pronta para o segundo adapter.
- **Exportação de serviço:** os valores padrão do `comExt` (transfronteiriço, moeda 790/Real, sem fomento, sem envio ao MDIC) e a regra "tomador no exterior = exportação" precisam ser validados com um contador e em homologação.
- **`pTotTribSN`:** usa o percentual aproximado do IBPT configurado na empresa (`approximateTaxes.rateBps`; contabilidade, 19/10/2026: 15,53% para serviços). Sem configuração, cai na alíquota estimada do Simples.
- **Retenções federais** (IRRF/CSLL/PIS/COFINS/INSS) ainda não entram no DPS. A emissão é recusada localmente com mensagem clara.
- **DANFSe** segue os elementos da NT 008/2026 (chave, QR Code, tarja de cancelada), mas não reproduz o leiaute oficial pixel a pixel.
- **Ginfes, ainda não testado contra a prefeitura real:** o WSDL só abre com o certificado; falta confirmar se SBC aceita o cancelamento v3 e quanto o lote demora para processar. Comece pelo modo piloto e por `list_municipal_invoices`.
- **Perfil microSaaS** (010501 / NBS 115062100 / cIndOp 100501) precisa de validação de um contador. O cIndOp 100501 é o que a tabela oficial associa ao 01.05, mas é incomum com NBS de serviço. A alternativa seria 010302 (hospedagem) com 100301.
- **ISS estimado no Simples** usa a parcela da 1ª faixa do Anexo III (33,5%). Em outras faixas ou no Anexo V (Fator R abaixo de 28%, comum em software) a parcela é outra; o usuário pode informar `issRateBps`.
- **IBS/CBS:** obrigatório para o Simples a partir de 01/01/2027. Hoje, venda para consumidor sem CPF/CNPJ sai sem tomador e sem o grupo IBS/CBS, porque o cIndOp 100301 exige o endereço do tomador (E0234). A partir de 2027 será preciso coletar o CPF nessas vendas.
- **Catálogo de códigos de serviço** é um subconjunto curado da LC 116. A validade no município é confirmada via `get_municipal_rate`.
- **AbacatePay:**
  - o payload v2 não traz o celular do cliente, então não há envio por WhatsApp nesses casos;
  - `billing.refunded` (API v1) não aparece na documentação oficial; é tratado por precaução.
- **Autenticação do MCP** é por API key. OAuth 2.1 fica para depois.
- **Regime tributário:** a BrasilAPI só informa Simples/MEI. Para as demais empresas o regime fica como Lucro Presumido, e o usuário corrige na etapa 3 se for Lucro Real.
- **Link de upload do certificado** expira em 30 min, mas pode ser usado mais de uma vez dentro desse prazo.
