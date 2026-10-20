# Menu "Agentes de IA" e a etapa 5 do onboarding

**Para o Replit Agent.** Hoje as chaves do MCP só aparecem na etapa 5 do onboarding ("Seu assistente assume daqui"). Isso traz três problemas:
- depois do onboarding, o usuário precisa voltar ao fluxo de configuração para gerir as chaves;
- quem guardou a chave mas esqueceu como conectar não acha as instruções e acaba gerando outra chave;
- a lista de chaves fica misturada com o texto de boas-vindas.

## Regras

- Não invente campos nem rotas.
- As chamadas continuam saindo do backend do app, como hoje.
- A chave completa **nunca** é enviada ao servidor do app nem guardada. Ela só aparece uma vez, quando é gerada.

## 1. Etapa 5 do onboarding: só a primeira chave

- **Conteúdo:**
  - o texto atual;
  - o campo "Nome da chave";
  - o botão "Gerar minha chave";
  - depois de gerar, a chave (uma única vez) e o guia de conexão preenchido com ela.
- **Tirar da etapa:** a lista "Chaves ativas", o "Revogar todas as chaves" e o texto sobre chaves antigas. Tudo isso vai para o menu novo.
- **Novo botão "Concluir":** leva ao Painel.
- **Se a empresa já tem chave ativa** (`GET .../mcp-keys` com itens): troque o formulário por "Você já tem uma chave. Gerencie em Agentes de IA" e mostre o botão "Concluir".

## 2. Novo menu "Agentes de IA"

**Onde:** uma aba nova no menu principal, ao lado de Painel, Dados fiscais e Saldo. A página tem três blocos.

### a) Como conectar

- **Dados:** `GET /v1/app/companies/{tenantId}/mcp-connection`. A rota não gera chave nenhuma. Ela devolve:

  | Campo | O que é |
  |---|---|
  | `mcpUrl` | o endereço do MCP |
  | `keyPlaceholder` | o marcador `<SUA_CHAVE>` |
  | `authorizationHeader` | o cabeçalho `Authorization: Bearer <SUA_CHAVE>` |
  | `claudeCodeCommand` | o comando do Claude Code |
  | `jsonConfig` | o JSON de configuração (`mcpServers`) |

- **Abas por cliente:**
  - **Claude Code:** `claudeCodeCommand`.
  - **Arquivo de configuração (JSON):** `jsonConfig`, para clientes que leem um arquivo `mcpServers`.
  - **Outro cliente MCP:** `mcpUrl` e `authorizationHeader`.

  Cada aba tem um botão "Copiar".
- **Campo opcional "Cole sua chave para preencher os comandos":**
  - Ele troca `keyPlaceholder` pela chave **só no navegador**, para facilitar a cópia.
  - A chave nunca é enviada ao servidor, nem salva em `localStorage`.
  - Texto ao lado: "A chave fica só no seu navegador."
- **Explicação:**
  - "Guardou a chave? Use estes comandos, não precisa gerar outra."
  - "Perdeu a chave? Gere uma nova abaixo e revogue a antiga."

### b) Chaves ativas

- **Lista:** use `GET .../mcp-keys` e mostre nome, final, criação e último uso, como hoje.
- **Revogar:** `DELETE .../mcp-keys/{keyId}`.
- **Revogar todas:** `DELETE .../mcp-keys`, com confirmação.
- **Texto sobre chaves antigas:** mantenha ("use o MCP uma vez e clique em Atualizar").

### c) Gerar nova chave

- **Formulário:** campo "Nome da chave" e o botão "Gerar chave", que chama `POST .../mcp-key`.
- **Depois de gerar:**
  - mostre a chave uma única vez, com "Copiar" e o aviso "Guarde agora: ela não aparece de novo";
  - mostre os comandos já preenchidos, que vêm na própria resposta (`claudeCodeCommand`, `jsonConfig`);
  - atualize a lista de chaves.

## 3. Aba "Configuração" depois do onboarding

- **Concluído o onboarding:**
  - o app abre no **Painel**, e não na etapa 5;
  - a aba "Configuração" só aparece enquanto houver alguma etapa pendente.
- **Se algum dado ficar inacessível** sem a aba "Configuração" (ex.: refazer a conexão com o AbacatePay ou trocar o certificado), **não esconda a aba**. Mantenha-a e avise no relatório o que só existe lá.

## Formato da resposta

Ao terminar, devolva:
- as telas e os componentes alterados;
- o que ficou acessível só pela aba "Configuração", se houver.
