# Política de segurança

O açaínfe guarda certificados digitais A1 e emite documentos fiscais em nome de empresas. Levamos vulnerabilidades a sério e agradecemos quem as reporta com responsabilidade.

## Como reportar

**Não abra issue, discussão ou PR público.** Use um destes canais privados:

1. **GitHub:** aba [Security → Report a vulnerability](https://github.com/extractify/acainfe-api/security/advisories/new) (preferido).
2. **E-mail:** contato@extractify.com.br, com o assunto `[SEGURANÇA]`.

Inclua o que for possível: descrição, impacto, passos para reproduzir, versão (commit) e uma prova de conceito mínima.

## O que esperar

| Etapa                          | Prazo                                          |
| ------------------------------ | ---------------------------------------------- |
| Confirmação de recebimento     | até 2 dias úteis                               |
| Avaliação inicial e severidade | até 5 dias úteis                               |
| Correção de falhas críticas    | o mais rápido possível, em geral em até 7 dias |

Mantemos você informado e, se quiser, damos crédito no aviso publicado depois da correção.

## Escopo

**Dentro:** este repositório e a instância hospedada em `api.acainfe.com` (API REST, MCP, webhooks, links assinados, upload de certificado).

**Fora:**

- ataques de negação de serviço, testes de carga ou spam;
- engenharia social contra a equipe ou clientes;
- relatórios automáticos sem impacto demonstrado (cabeçalhos ausentes, versões de software);
- vulnerabilidades em sistemas de terceiros (prefeituras, Sefin, AbacatePay), que devem ser reportadas a eles.

## Regras para testes

- Use **apenas sua própria conta** e o CNPJ de teste `99.000.001/0001-01`. Nunca cadastre, envie certificado ou emita nota com CNPJ de outra pessoa ou empresa.
- Não acesse, altere nem guarde dados de outros clientes. Se encontrar dados de terceiros por acidente, pare, não os compartilhe e reporte.
- Não emita nem cancele notas fiscais reais.

## Porto seguro

Não tomaremos medidas legais contra pesquisas feitas de boa-fé, dentro destas regras, e reportadas em privado com tempo razoável para correção antes de qualquer divulgação.

## Versões suportadas

Apenas a branch `main` recebe correções de segurança.
