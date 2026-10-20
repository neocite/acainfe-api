import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

/** Simula BrasilAPI (CNPJ) e a API v2 do AbacatePay para os testes e2e. */
export class FakeExternalApis {
  readonly companies = new Map<string, Record<string, unknown>>();
  products: Record<string, unknown>[] = [];
  readonly webhooks: Record<string, unknown>[] = [];
  readonly pixCharges: Record<string, unknown>[] = [];
  /** Histórico de vendas exposto em /checkouts/list, /transparents/list e /subscriptions/checkouts/list. */
  history: {
    checkouts: Record<string, unknown>[];
    transparents: Record<string, unknown>[];
    subscriptions: Record<string, unknown>[];
  } = {
    checkouts: [],
    transparents: [],
    subscriptions: [],
  };
  customers: Record<string, unknown>[] = [];
  validKey = 'abc_live_e2e_key';
  private server?: Server;

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const cnpj = url.pathname.match(/^\/cnpj\/v1\/(\d{14})$/);
    if (cnpj) {
      const company = this.companies.get(cnpj[1]);
      return company ? send(200, company) : send(404, { message: 'CNPJ não encontrado' });
    }
    if (url.pathname.startsWith('/v2/')) {
      if (req.headers.authorization !== `Bearer ${this.validKey}`)
        return send(401, { success: false, error: 'Unauthorized' });
      const lists: Record<string, Record<string, unknown>[]> = {
        '/v2/checkouts/list': this.history.checkouts,
        '/v2/transparents/list': this.history.transparents,
        '/v2/subscriptions/checkouts/list': this.history.subscriptions,
        '/v2/customers/list': this.customers,
      };
      if (req.method === 'GET' && lists[url.pathname]) {
        return send(200, {
          data: lists[url.pathname],
          success: true,
          error: null,
          pagination: { hasMore: false },
        });
      }
      if (req.method === 'GET' && url.pathname === '/v2/products/list') {
        return send(200, {
          data: this.products,
          success: true,
          error: null,
          pagination: { hasMore: false },
        });
      }
      if (req.method === 'POST' && url.pathname === '/v2/transparents/create') {
        const body = JSON.parse(raw);
        const id = `pix_char_${this.pixCharges.length + 1}`;
        this.pixCharges.push({ id, ...body });
        return send(200, {
          data: {
            id,
            amount: body.data.amount,
            status: 'PENDING',
            brCode: `00020126${id}`,
            brCodeBase64: 'data:image/png;base64,AAAA',
            expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
          },
          success: true,
          error: null,
        });
      }
      if (req.method === 'POST' && url.pathname === '/v2/webhooks/create') {
        const body = JSON.parse(raw);
        this.webhooks.push(body);
        return send(200, {
          data: { id: `webh_${this.webhooks.length}`, ...body },
          success: true,
          error: null,
        });
      }
    }
    send(404, { error: `rota fake inexistente: ${req.method} ${url.pathname}` });
  }
}

/** Payload no formato da BrasilAPI. */
export function brasilApiCompany(
  cnpj: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    cnpj,
    razao_social: 'AÇAÍ DIGITAL LTDA',
    nome_fantasia: 'Açaí Digital',
    codigo_municipio_ibge: 3548708,
    municipio: 'SAO BERNARDO DO CAMPO',
    uf: 'SP',
    opcao_pelo_simples: true,
    opcao_pelo_mei: false,
    descricao_situacao_cadastral: 'ATIVA',
    cnae_fiscal: 8599604,
    cnae_fiscal_descricao: 'Treinamento em desenvolvimento profissional e gerencial',
    cnaes_secundarios: [
      { codigo: 6201501, descricao: 'Desenvolvimento de programas de computador sob encomenda' },
    ],
    descricao_tipo_de_logradouro: 'RUA',
    logradouro: 'MARECHAL DEODORO',
    numero: '100',
    bairro: 'CENTRO',
    cep: '09715000',
    ...overrides,
  };
}
