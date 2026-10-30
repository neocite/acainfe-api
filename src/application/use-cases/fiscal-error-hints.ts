import { FiscalError } from '../../domain/invoice/invoice.js';

/**
 * Dicas legíveis para rejeições comuns. A lista é propositalmente curta — o agente de IA
 * (via MCP) recebe código + descrição oficial e complementa a explicação.
 */
const HINTS: { match: RegExp; hint: string }[] = [
  {
    match: /\bE344\b/,
    hint: 'A prefeitura não aceitou o município no pedido de cancelamento. O açaínfe já tenta o leiaute alternativo (sem município); se persistir, cancele pelo portal da prefeitura e avise o suporte.',
  },
  {
    match: /\bE197\b/,
    hint: 'Valor do ISS retido incoerente com o ISS. Confira se o produto tem retenção de ISS (issRetention) correta para este cliente e use retry_invoice.',
  },
  {
    match: /\bE208\b/,
    hint: 'Optante do Simples sem ISS retido: o valor do ISS na nota deve ser zero (é pago no DAS). Confira se o regime da empresa e a retenção do produto estão corretos e use retry_invoice.',
  },
  {
    match: /\bE166\b|RegimeEspecialTributa/i,
    hint: 'A prefeitura exige o regime especial do Simples (5 = MEI, 6 = ME/EPP). Confira o regime tributário da empresa com get_company/update_company e use retry_invoice.',
  },
  {
    match: /AWAITING_APPROVAL/,
    hint: 'Modo piloto: mostre a prévia ao usuário com preview_invoice (prestador, tomador, valor, código de serviço, alíquota) e, se ele confirmar, use approve_invoice.',
  },
  {
    match: /GINFES_DADOS/,
    hint: 'Faltam dados exigidos pelo sistema da prefeitura (Ginfes). Complete o que a mensagem pede (ex.: CCM com update_company) e use retry_invoice.',
  },
  {
    match: /PAULISTANA_DADOS/,
    hint: 'Faltam dados exigidos pela NFS-e da prefeitura de São Paulo. Complete o que a mensagem pede (ex.: CCM com update_company, ou o código de serviço de 5 dígitos do produto, como 05762) e use retry_invoice.',
  },
  {
    match: /\b1206\b|\b1057\b|\b1056\b/,
    hint: 'A prefeitura de São Paulo recusou a assinatura (do RPS ou da mensagem). É um problema do açaínfe, não do usuário: avise o suporte com o código do erro; não adianta reprocessar.',
  },
  {
    match: /\b306\b|\b310\b|\b361\b|\b367\b|c[óo]digo de servi[çc]o/i,
    hint: 'Código de serviço de São Paulo inválido ou não permitido para a empresa. Confira com o contador o código de 5 dígitos (ex.: 05762 cursos, 02800 licenciamento de software), corrija o localServiceCode do produto e use retry_invoice.',
  },
  {
    match: /\b1647\b|\b641\b|\b632\b|ambiente nacional/i,
    hint: 'A prefeitura de São Paulo exige outro leiaute ou o Emissor Nacional para esta data/regime (migração do Simples em 01/11/2026). Avise o suporte: a empresa deve passar a emitir pelo Emissor Nacional (fiscalProvider NACIONAL).',
  },
  {
    match: /\bE35\b|c[óo]digo de tributa[çc][ãa]o inexistente/i,
    hint: 'O código de tributação municipal do produto não existe na prefeitura. Confira o localServiceCode (formato de São Bernardo: 8.02/103911/1551) numa nota antiga, corrija o produto e use retry_invoice.',
  },
  {
    match: /AWAITING_MUNICIPALITY/,
    hint: 'A prefeitura ainda não liberou o Emissor Nacional para a empresa (virada de 01/11/2026). O açaínfe tenta de novo a cada hora sozinho: não é preciso fazer nada. Se demorar mais de um dia, avise o suporte.',
  },
  {
    match: /E0039|parametrizado para utilizar os emissores p[úu]blicos nacionais/i,
    hint: 'O município ainda não usa o Emissor Nacional para esta empresa: notas com competência anterior à virada (01/11/2026) saem pelo sistema da prefeitura (Ginfes em São Bernardo, NFS-e Paulistana em São Paulo). Se for posterior, a nota aguarda a liberação da prefeitura e é reenviada sozinha.',
  },
  {
    match: /E0234|endere[çc]o do tomador [ée] obrigat/i,
    hint: 'A prefeitura exige o tomador identificado com endereço. Peça o CPF/CNPJ do cliente e o endereço completo (CEP, rua, número, bairro), atualize o cliente (update_customer) e use retry_invoice.',
  },
  {
    match: /E0116|inscri[çc][ãa]o municipal.*(obrigat|exig|não informad)/i,
    hint: 'Esta prefeitura exige a inscrição municipal (CCM) na nota. Peça o número ao usuário (está no alvará ou no cadastro da prefeitura), salve com update_company (municipalRegistration) e use retry_invoice.',
  },
  {
    match: /DPS_NUMBER_CONFLICT/,
    hint: 'A numeração colidiu com notas de outro sistema. Use set_invoice_numbering (série exclusiva, ex.: 900, ou o próximo número livre) e depois retry_invoice: a nota recebe um número novo.',
  },
  {
    match: /BILLING_BLOCKED/,
    hint: 'A emissão está pausada por saldo em aberto no açaínfe. Use get_billing e pay_billing para gerar o Pix; as notas saem automaticamente após o pagamento.',
  },
  {
    match: /CERTIFICATE_MISSING/,
    hint: 'Envie o certificado A1 (.pfx) da empresa em POST /v1/certificates e reprocesse a nota.',
  },
  {
    match: /CERTIFICATE_INVALID/,
    hint: 'O certificado está vencido ou é de outro CNPJ. Envie um certificado A1 válido da empresa.',
  },
  {
    match: /al[ií]quota/i,
    hint: 'Revise o issRateBps do produto: o município pode parametrizar alíquota própria para este código (consulte municipal-params).',
  },
  {
    match: /c[óo]digo de tributa[çc][ãa]o|cTribNac|servi[çc]o/i,
    hint: 'O código de serviço (nationalServiceCode) pode não estar habilitado no município. Use suggest_service_code / municipal-params.',
  },
  {
    match: /inscri[çc][ãa]o municipal|CNC|cadastro/i,
    hint: 'A empresa precisa estar habilitada no Sistema Nacional NFS-e (primeiro acesso no Emissor Nacional) com a inscrição municipal ativa.',
  },
  {
    match: /simples/i,
    hint: 'Confira o regime tributário (taxRegime) da empresa: a opção pelo Simples Nacional informada difere do cadastro da Receita.',
  },
  {
    match: /tomador|CPF|CNPJ/i,
    hint: 'Revise os dados do tomador (CPF/CNPJ e nome). Ao informar documento, o nome é obrigatório.',
  },
];

export function explainFiscalErrors(errors: FiscalError[]): string[] {
  const hints = new Set<string>();
  for (const error of errors) {
    const text = `${error.code} ${error.message} ${error.complement ?? ''}`;
    for (const { match, hint } of HINTS) if (match.test(text)) hints.add(hint);
  }
  if (errors.length && !hints.size) {
    hints.add(
      'Corrija os dados indicados pela prefeitura (produto, empresa ou tomador) e use retry_invoice para reprocessar.'
    );
  }
  return [...hints];
}
