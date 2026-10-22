/**
 * Régua de ativação: lembra quem parou no meio do cadastro, pela etapa em que parou. Para sozinha
 * quando a etapa é concluída; no máximo uma mensagem por passo da cadência; só em horário comercial.
 */
export type ActivationStage =
  'NO_CERTIFICATE' | 'NO_GATEWAY' | 'PRODUCTS_PENDING' | 'NO_FIRST_INVOICE';

const HOUR = 3_600_000;

/** Quando lembrar, contado a partir do início da etapa. */
export const ACTIVATION_CADENCE: Record<ActivationStage, number[]> = {
  NO_CERTIFICATE: [1 * HOUR, 24 * HOUR, 72 * HOUR],
  NO_GATEWAY: [24 * HOUR, 72 * HOUR],
  PRODUCTS_PENDING: [24 * HOUR, 72 * HOUR],
  NO_FIRST_INVOICE: [7 * 24 * HOUR],
};

export const STAGE_LABEL: Record<ActivationStage, string> = {
  NO_CERTIFICATE: 'Conta criada, sem certificado',
  NO_GATEWAY: 'Certificado enviado, sem AbacatePay',
  PRODUCTS_PENDING: 'Produtos aguardando tributação',
  NO_FIRST_INVOICE: 'Tudo pronto, sem nenhuma nota',
};

export interface ActivationLog {
  /** Pediu para não receber mais lembretes. */
  optedOutAt?: Date;
  sent: { stage: ActivationStage; step: number; at: Date }[];
}

/**
 * Passo da cadência que deve ser enviado agora (1, 2, 3…) ou null. Se vários passos venceram sem
 * envio (ex.: servidor parado), manda só o mais recente — nunca uma rajada.
 */
export function dueStep(
  stage: ActivationStage,
  since: Date,
  now: Date,
  log: ActivationLog | undefined
): number | null {
  if (log?.optedOutAt) return null;
  const elapsed = now.getTime() - since.getTime();
  const due = ACTIVATION_CADENCE[stage].filter((offset) => offset <= elapsed).length;
  const last = Math.max(
    0,
    ...(log?.sent ?? []).filter((s) => s.stage === stage).map((s) => s.step)
  );
  return due > last ? due : null;
}

/** Só manda entre 9h e 20h de Brasília. */
export function isBusinessHour(now: Date): boolean {
  const hour = new Date(now.getTime() - 3 * HOUR).getUTCHours();
  return hour >= 9 && hour < 20;
}

export interface ActivationMessageInput {
  stage: ActivationStage;
  firstName?: string;
  appUrl: string;
  unsubscribeUrl?: string;
  /** Produtos aguardando tributação (etapa PRODUCTS_PENDING). */
  pendingProducts?: string[];
  companyName?: string;
}

/** Texto do lembrete (o mesmo no WhatsApp e no e-mail). */
export function activationMessage(input: ActivationMessageInput): {
  subject: string;
  text: string;
} {
  const hi = input.firstName ? `Oi, ${input.firstName}!` : 'Oi!';
  const app = input.appUrl.replace(/\/$/, '');
  const footer = input.unsubscribeUrl
    ? `\n\nNão quer mais receber estes lembretes? ${input.unsubscribeUrl}`
    : '';
  const bodies: Record<ActivationStage, { subject: string; text: string }> = {
    NO_CERTIFICATE: {
      subject: 'Falta só o certificado para emitir sua primeira nota',
      text:
        `${hi} Falta só um passo para o açaínfe emitir suas notas sozinho: enviar o certificado digital A1 (e-CNPJ) da sua empresa.\n\n` +
        `• É o arquivo .pfx (ou .p12) que você recebeu da certificadora, com a senha dele. Se o seu for A3 (token ou cartão), peça um A1 à certificadora.\n` +
        `• Não sabe onde está? Seu contador costuma ter.\n` +
        `• Ele fica guardado criptografado e só é usado para assinar as notas.\n\n` +
        `Continue de onde parou: ${app}`,
    },
    NO_GATEWAY: {
      subject: 'Conecte o AbacatePay e cada venda vira nota sozinha',
      text:
        `${hi} ${input.companyName ? `A ${input.companyName} já está` : 'Sua empresa já está'} pronta no açaínfe. Falta conectar o AbacatePay: a partir daí, cada venda paga vira nota fiscal automaticamente.\n\n` +
        `No painel do AbacatePay, crie uma chave de API e cole no açaínfe. Leva 2 minutos: ${app}`,
    },
    PRODUCTS_PENDING: {
      subject: 'Seus produtos estão esperando a tributação',
      text:
        `${hi} ${input.pendingProducts?.length ? `${input.pendingProducts.slice(0, 3).join(', ')}${input.pendingProducts.length > 3 ? ' e outros' : ''} ainda não podem` : 'Alguns produtos ainda não podem'} virar nota: falta confirmar a tributação (o código do serviço).\n\n` +
        `As vendas que chegarem antes ficam guardadas e viram nota assim que você confirmar. Confirme aqui: ${app}`,
    },
    NO_FIRST_INVOICE: {
      subject: 'Está tudo pronto para a sua primeira nota',
      text:
        `${hi} Está tudo configurado no açaínfe: a próxima venda paga no AbacatePay vira nota fiscal sozinha, e o seu cliente recebe por e-mail.\n\n` +
        `Quer ver funcionando antes? Emita uma nota avulsa pelo app ou peça ao seu agente de IA: ${app}`,
    },
  };
  const body = bodies[input.stage];
  return { subject: body.subject, text: body.text + footer };
}
