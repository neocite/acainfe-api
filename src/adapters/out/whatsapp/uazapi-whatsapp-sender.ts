import { WhatsappDocumentMessage, WhatsappSender } from '../../../application/ports/services.js';

/**
 * uazapi (https://docs.uazapi.com): cada instância tem servidor próprio e autentica via header `token`.
 * Envia o DANFSe como documento (POST /send/media, type=document). Prefere URL pública assinada do PDF;
 * sem URL, envia o arquivo em base64.
 */
export class UazapiWhatsappSender implements WhatsappSender {
  constructor(
    private readonly baseUrl: string,
    private readonly instanceToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendDocument(message: WhatsappDocumentMessage): Promise<void> {
    await this.post('/send/media', {
      number: message.phone,
      type: 'document',
      file: message.fileUrl ?? `data:application/pdf;base64,${message.file.toString('base64')}`,
      docName: message.fileName,
      mimetype: 'application/pdf',
      text: message.caption,
    });
  }

  async sendText(phone: string, text: string): Promise<void> {
    await this.post('/send/text', { number: phone, text });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: this.instanceToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message_ptbr?: string;
      };
      throw new Error(
        `uazapi HTTP ${response.status}: ${data.message_ptbr ?? data.error ?? 'erro desconhecido'}`
      );
    }
  }
}

export class InMemoryWhatsappSender implements WhatsappSender {
  readonly sent: WhatsappDocumentMessage[] = [];
  readonly texts: { phone: string; text: string }[] = [];
  async sendDocument(message: WhatsappDocumentMessage): Promise<void> {
    this.sent.push(message);
  }
  async sendText(phone: string, text: string): Promise<void> {
    this.texts.push({ phone, text });
  }
}
