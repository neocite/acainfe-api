## O que muda

<!-- Uma ou duas frases. Linke a issue: Closes #123 -->

## Como testei

- [ ] `pnpm typecheck && pnpm lint`
- [ ] `pnpm test` (unitários)
- [ ] `pnpm test:e2e`
- [ ] Mudança no XML enviado à prefeitura/Sefin validada contra o XSD oficial em `test/fixtures/xsd/`

## Checklist

- [ ] Valores em inteiros (centavos e pontos-base), sem `float`
- [ ] Sem dados reais (CPF/CNPJ de terceiros, certificados, chaves) em código, testes ou descrição
- [ ] README/`.env.example` atualizados se mudou configuração ou comportamento
