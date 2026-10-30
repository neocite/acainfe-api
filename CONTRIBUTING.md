# Como contribuir com o açaínfe

Obrigado pelo interesse! O açaínfe emite notas fiscais de verdade, então o cuidado com correção e segurança vem antes da velocidade. Este guia mostra como montar o ambiente, o que esperamos de um PR e as regras do domínio que não podem ser quebradas.

## Antes de começar

- **Bugs e sugestões:** abra uma [issue](https://github.com/extractify/acainfe-api/issues/new/choose). Para mudanças grandes (nova prefeitura, novo gateway, mudança de modelo), discuta na issue antes de escrever código.
- **Vulnerabilidades:** nunca em issue pública. Veja o [SECURITY.md](SECURITY.md).
- **Conduta:** seguimos o [Código de Conduta](CODE_OF_CONDUCT.md).

## Ambiente

Requisitos: Node **22.23.4+** (veja `.nvmrc`), pnpm (via `corepack enable`) e Docker para o MongoDB local.

```bash
pnpm install
cp .env.example .env     # ADMIN_API_KEY, MASTER_KEYS (openssl rand -base64 32), LINK_SIGNING_SECRET
docker compose up -d mongo
pnpm start:dev           # http://localhost:3000/docs e /mcp
```

Os testes não precisam de `.env` nem de Docker: o e2e sobe um MongoDB real com `mongodb-memory-server` e usa fakes da Sefin, do Ginfes, da Paulistana, do AbacatePay, do e-mail e do WhatsApp.

```bash
pnpm typecheck && pnpm lint
pnpm test        # unitários
pnpm test:e2e    # ponta a ponta
pnpm build
```

## Arquitetura em 30 segundos

Hexagonal (portas e adaptadores), NestJS sobre Fastify:

| Pasta              | O que tem                                                        |
| ------------------ | ---------------------------------------------------------------- |
| `src/domain`       | Regras de negócio puras, sem I/O                                 |
| `src/application`  | Casos de uso e portas (`ports/`)                                 |
| `src/adapters/in`  | HTTP, MCP, webhooks e jobs (Agenda)                              |
| `src/adapters/out` | Prefeituras/Sefin (`fiscal/`), MongoDB, cripto, e-mail, WhatsApp |
| `src/config`       | Variáveis de ambiente e montagem das dependências                |

Uma prefeitura nova é um adaptador em `src/adapters/out/fiscal/<sistema>/` que implementa a porta `FiscalProvider`, mais um fake em `test/e2e/support/` e um e2e.

## Regras do domínio (não negociáveis)

1. **Números são inteiros.** Dinheiro em centavos (`R$ 82,20 = 8220`) e percentuais em pontos-base (`2,01% = 201`). Nada de `float` em valores fiscais; converta texto sem `parseFloat(x) * 100`.
2. **XML fiscal validado contra o XSD oficial.** Mudou o que vai para a Sefin ou para a prefeitura? Adicione ou ajuste o teste que valida contra `test/fixtures/xsd/`.
3. **Nunca emitir em duplicidade.** Reenvios consultam o documento antes; preserve esse comportamento.
4. **Sem dados reais.** Nada de CPF/CNPJ de terceiros, certificados, chaves ou XML de notas reais em código, testes, issues ou PRs. Use os documentos de teste já presentes nos specs (ex.: CPF `529.982.247-25`, CNPJ `11.444.777/0001-61`) ou gere um certificado com `generateTestPfx`.
5. **Não teste contra produção com empresas reais.** O único CNPJ de teste autorizado em produção é `99.000.001/0001-01`.
6. **Segredos só em variáveis de ambiente.** Nenhuma chave em código ou em `.env.example`.

## Pull requests

1. Faça um fork e crie uma branch a partir de `main` (`feat/curitiba`, `fix/ginfes-cancelamento`).
2. Commits no estilo [Conventional Commits](https://www.conventionalcommits.org/pt-br/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
3. Todo comportamento novo vem com teste unitário e, se cruzar adaptadores, com e2e.
4. Rode `pnpm format` e garanta que o CI passa.
5. Atualize o README e o `.env.example` quando mudar configuração ou comportamento visível.
6. PRs pequenos são revisados mais rápido.

Ao enviar uma contribuição, você concorda que ela seja licenciada sob a [AGPL-3.0](LICENSE), a mesma licença do projeto.

## Idioma

Código, testes, mensagens de erro e documentação estão em português, porque o domínio (legislação fiscal brasileira) é em português. Issues e PRs em inglês também são bem-vindos.
