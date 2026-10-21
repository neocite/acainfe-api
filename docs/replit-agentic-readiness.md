# Site preparado para agentes de IA (acainfe.com)

**Para o Replit Agent.** O açaínfe quer ser o primeiro emissor de NFS-e brasileiro pensado para agentes de IA. O site acainfe.com tirou 46/100 numa avaliação de prontidão para agentes. Implemente os itens abaixo **sem mudar o visual nem o comportamento atual** do site e do app.

## Regras

- Não exponha nada interno: nenhuma chave, nenhuma rota `/v1/admin`, nenhum detalhe de autenticação além de "gere sua chave no app".
- Adicione testes para cada comportamento novo.
- No fim, verifique cada URL com os comandos `curl` desta seção.

### Comandos de verificação

```
curl -sS -i https://acainfe.com/ -H 'Accept: text/html'
curl -sS -i https://acainfe.com/ -H 'Accept: text/markdown'
curl -sS -i https://acainfe.com/nao-existe -H 'Accept: text/markdown'
curl -sS -i https://acainfe.com/nao-existe
curl -sS -i https://acainfe.com/sign-in
curl -sS https://acainfe.com/llms.txt
curl -sS https://acainfe.com/sitemap.xml
curl -sS https://acainfe.com/robots.txt
curl -sS https://acainfe.com/sobre
curl -sS https://acainfe.com/contato
curl -sS https://acainfe.com/privacidade
```

## 1. 404 de verdade

- **Página inexistente:** o servidor responde **HTTP 404** com a página de erro do app.
- **Pedido em Markdown:** com `Accept: text/markdown`, a resposta é **404**, com `Content-Type: text/markdown; charset=utf-8` e este corpo:
  ```
  # Página não encontrada

  Este endereço não existe no açaínfe. Veja o que o açaínfe faz e como agentes de IA podem usá-lo em https://acainfe.com/llms.txt, ou a lista de páginas em https://acainfe.com/sitemap.xml.
  ```
- **Rotas do app continuam com 200.** Isso vale para `/`, `/sign-in`, `/sign-up`, `/onboarding`, as telas logadas, `/sobre`, `/contato`, `/privacidade`, os arquivos estáticos e `/api/*`.
- **Lista de rotas válidas:** mantenha uma lista explícita no servidor, gerada a partir do roteador do front se possível, para não quebrar links diretos.

## 2. Conteúdo sem JavaScript

- **HTML pré-renderizado:** a página inicial precisa vir com o conteúdo da landing já no HTML, com pelo menos 500 caracteres de texto.
  - Um único `<h1>` (ex.: "açaínfe: nota fiscal de serviço (NFS-e) automática para quem vende no AbacatePay").
  - Títulos `<h2>` e `<h3>` em ordem.
  - Seções: como funciona, preço (R$ 0,80 por nota, sem mensalidade), cidades atendidas (São Paulo e São Bernardo do Campo, MEI e Simples Nacional), agentes de IA/MCP e dúvidas.
- **Visual:** o React hidrata por cima, então o visual não muda.

## 3. Markdown na página inicial

- **`GET /` com `Accept: text/markdown`:** responde 200 com `Content-Type: text/markdown; charset=utf-8` e `Vary: Accept`. O corpo é a versão em Markdown da landing: o mesmo conteúdo do item 2 mais o resumo do `llms.txt`.
- **`GET /` com `Accept: text/html` (navegador):** continua devolvendo o HTML, também com `Vary: Accept`.

## 4. JSON-LD na página inicial

Coloque no `<head>`, dentro de `<script type="application/ld+json">`, um `@graph` com dois objetos:

```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://acainfe.com/#software",
      "name": "açaínfe",
      "url": "https://acainfe.com",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "inLanguage": "pt-BR",
      "description": "Emissor de NFS-e (nota fiscal de serviço eletrônica) automático e operável por agentes de IA via MCP. Cada pagamento aprovado no AbacatePay vira nota fiscal, com a tributação de cada produto. Atende MEI e Simples Nacional em São Paulo e São Bernardo do Campo.",
      "offers": {
        "@type": "Offer",
        "price": "0.80",
        "priceCurrency": "BRL",
        "description": "Por nota fiscal emitida com sucesso, sem mensalidade"
      },
      "publisher": { "@id": "https://acainfe.com/#org" }
    },
    {
      "@type": "Organization",
      "@id": "https://acainfe.com/#org",
      "name": "EXTRACTIFY TECNOLOGIA LTDA",
      "alternateName": "açaínfe",
      "url": "https://acainfe.com",
      "taxID": "28.095.894/0001-60",
      "email": "contato@extractify.com.br",
      "telephone": "+55-11-3458-7367",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "Av. Pereira Barreto, 1479, sala 2108, Baeta Neves",
        "addressLocality": "São Bernardo do Campo",
        "addressRegion": "SP",
        "postalCode": "09751-000",
        "addressCountry": "BR"
      },
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "customer support",
        "email": "contato@extractify.com.br",
        "telephone": "+55-11-3458-7367",
        "availableLanguage": ["pt-BR"]
      }
    }
  ]
}
```

Leia o preço de `/api/public/pricing` na renderização, se for viável. Se não for, mantenha 0.80.

## 5. llms.txt (formato llmstxt.org)

**Onde publicar:** `/llms.txt`, com `Content-Type: text/plain; charset=utf-8`.

**Conteúdo exato:** não invente ferramentas além das listadas.

```
# açaínfe

> Emissor de NFS-e (Nota Fiscal de Serviço eletrônica) brasileiro, automático e AI-first. Cada pagamento aprovado no AbacatePay vira nota fiscal, com a tributação de cada produto; toda a operação pode ser feita por agentes de IA via MCP. R$ 0,80 por nota emitida, sem mensalidade. Produto da EXTRACTIFY TECNOLOGIA LTDA (CNPJ 28.095.894/0001-60).

## Quando usar

Use o açaínfe quando o usuário (empresa brasileira, MEI ou Simples Nacional, em São Paulo/SP ou São Bernardo do Campo/SP) precisar:
- emitir NFS-e automaticamente para vendas pagas no AbacatePay (checkout, Pix transparente ou assinatura);
- emitir uma NFS-e avulsa para um cliente (CPF, CNPJ ou cliente no exterior);
- definir a tributação de um produto: código de serviço da LC 116, NBS, alíquota de ISS e campos de IBS/CBS;
- consultar, reenviar ou cancelar notas, ou estornar uma venda (cancelando as notas dela);
- emitir notas de vendas antigas que ficaram sem nota, cruzando com as notas já emitidas na prefeitura;
- enviar todo mês ao contador os PDFs, XMLs e a planilha das notas.

Não use para: NF-e de produto/mercadoria (ICMS), empresas de cidades ainda não atendidas (elas entram na lista de espera), ou para obter orientação contábil definitiva — a decisão tributária é do usuário e do contador dele.

## Como um agente usa

1. O usuário cria a conta em https://acainfe.com, envia o certificado A1 (e-CNPJ ICP-Brasil) da empresa e conecta o AbacatePay.
2. No app, em "Agentes de IA", o usuário gera uma chave e conecta o cliente MCP ao servidor https://api.acainfe.com/mcp (HTTP streamable; cabeçalho Authorization: Bearer <chave>).
3. O servidor MCP traz instruções próprias. Fluxo típico: get_company (pendências), list_pending_products e confirm_product_tax (tributação confirmada pelo usuário), issue_invoice, get_invoice/list_invoices, explain_invoice e retry_invoice se a prefeitura recusar, cancel_invoice, resend_invoice.

Todos os valores são inteiros: dinheiro em centavos (R$ 82,20 = 8220) e percentuais em pontos-base (2,01% = 201).

## Páginas

- [Início](https://acainfe.com/): como funciona, preço e cidades atendidas
- [Sobre](https://acainfe.com/sobre): quem somos
- [Contato](https://acainfe.com/contato): suporte
- [Privacidade](https://acainfe.com/privacidade): como tratamos os dados
- [Cidades atendidas (JSON)](https://api.acainfe.com/v1/public/coverage)
- [Preço vigente (JSON)](https://api.acainfe.com/v1/public/pricing)
```

## 6. sitemap.xml e robots.txt

- **`/sitemap.xml`:** XML válido (sitemaps.org) com `/`, `/sobre`, `/contato`, `/privacidade` e `/llms.txt`, cada um com `<lastmod>` (data da publicação).
- **Fora do sitemap:** telas logadas, `/onboarding`, `/sign-in` e `/sign-up`.
- **`/robots.txt`:** inclua `Sitemap: https://acainfe.com/sitemap.xml`. Mantenha o que já existe.

## 7. Páginas institucionais

Use o mesmo visual do site, com link no rodapé. Cada página tem pelo menos 500 caracteres, está no sitemap e tem versão Markdown, pelo mesmo mecanismo do item 3.

### /sobre

- O açaínfe é um produto da **EXTRACTIFY TECNOLOGIA LTDA** (CNPJ 28.095.894/0001-60), de São Bernardo do Campo/SP.
- **O que faz:** emite NFS-e automaticamente para quem vende no AbacatePay, com a tributação de cada produto. Pode ser operado por conversa, com agentes de IA via MCP.
- **Para quem é:** MEI e Simples Nacional em São Paulo e São Bernardo do Campo; outras cidades entram na lista de espera.
- **Preço:** R$ 0,80 por nota, sem mensalidade.
- **Como emite:** pelo Emissor Nacional da NFS-e e, onde a prefeitura ainda exige, pelo sistema próprio dela (NFS-e Paulistana e Ginfes).

### /contato

- E-mail: contato@extractify.com.br
- Telefone: (11) 3458-7367
- Endereço: Av. Pereira Barreto, 1479, sala 2108, Baeta Neves, São Bernardo do Campo/SP, CEP 09751-000
- Empresa: EXTRACTIFY TECNOLOGIA LTDA, CNPJ 28.095.894/0001-60
- Orientação: dúvidas sobre uma nota fiscal emitida para você devem ir primeiro à empresa que emitiu a nota.

### /privacidade (rascunho para revisão)

Use exatamente estes tópicos e fatos, em linguagem clara. Mostre no topo "Versão de 21/10/2026" e um aviso discreto de que a política está em revisão. Não acrescente compromissos que não estão aqui.

1. **Quem somos:** EXTRACTIFY TECNOLOGIA LTDA (CNPJ 28.095.894/0001-60), controladora dos dados da conta. Contato para privacidade e direitos do titular: contato@extractify.com.br.
2. **Dados da conta:** nome, e-mail (do login) e WhatsApp do usuário, para acesso, avisos de emissão, cobrança e segurança.
3. **Dados da empresa cliente:**
   - **Cadastrais:** CNPJ, razão social, endereço, CNAEs e regime, com dados públicos da Receita Federal consultados pelo CNPJ.
   - **Fiscais:** inscrição municipal, alíquotas e tributação dos produtos.
4. **Certificado digital A1:** usado só para assinar e transmitir as notas à prefeitura e à Receita. Fica guardado criptografado e nunca é exibido nem compartilhado. Só são aceitos e-CNPJ emitidos pela ICP-Brasil.
5. **Integração com o AbacatePay:** a chave de API do usuário fica guardada criptografada e é usada para ler produtos e pagamentos e para cadastrar o webhook.
6. **Dados dos clientes da empresa (tomadores):**
   - Nome, CPF/CNPJ, e-mail, telefone e endereço vindos das vendas, usados para emitir e entregar a nota.
   - Nesse tratamento, o açaínfe atua como **operador**, em nome da empresa cliente, que é a controladora.
7. **Com quem compartilhamos:**
   - prefeituras e Receita Federal (emissão da nota);
   - o contador indicado pela empresa (pacote mensal);
   - provedores de e-mail e de WhatsApp (entrega da nota e avisos);
   - provedores de hospedagem e banco de dados;
   - o AbacatePay (gateway da empresa e cobrança do açaínfe).

   Não vendemos dados.
8. **Por quanto tempo:**
   - Documentos fiscais (notas e XMLs): pelo prazo exigido pela legislação tributária.
   - Demais dados: enquanto a conta estiver ativa ou conforme obrigação legal.
9. **Segurança:** criptografia dos segredos (certificado, chaves), chaves de API revogáveis pelo usuário em "Agentes de IA" e acesso restrito.
10. **Direitos do titular (LGPD, art. 18):** confirmação, acesso, correção, anonimização, portabilidade, eliminação e informação sobre compartilhamento, pedidos por contato@extractify.com.br. Tomadores devem procurar primeiro a empresa que emitiu a nota, que é a controladora.
11. **Cookies:** só os necessários ao login e ao funcionamento do app. Nenhum cookie de publicidade.
12. **Alterações:** esta política pode mudar. A data no topo indica a versão vigente.

## 8. Título e descrição (marca)

- **`<title>` da página inicial:** "açaínfe: emissor de NFS-e automático para AbacatePay, com agentes de IA (MCP)".
- **Meta description:** "Nota fiscal de serviço (NFS-e) automática para cada venda no AbacatePay, operável por agentes de IA via MCP. R$ 0,80 por nota, sem mensalidade. São Paulo e São Bernardo do Campo."
- **Imagem social:** mantenha a atual.

## Formato da resposta

Ao terminar, devolva:
- os arquivos alterados;
- a saída resumida de cada `curl` da seção "Comandos de verificação" (status, `Content-Type` e `Vary`);
- os testes adicionados.
