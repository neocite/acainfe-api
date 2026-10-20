import { Resend } from 'resend';
import { EmailMessage, EmailSender } from '../../../application/ports/services.js';

export class ResendEmailSender implements EmailSender {
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string
  ) {
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
        contentType: a.contentType,
      })),
    });
    if (error) throw new Error(`Resend: ${error.name ?? 'erro'} — ${error.message}`);
  }
}

/** Usado em desenvolvimento/testes: registra os e-mails em memória. */
export class InMemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
