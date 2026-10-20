import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { SignedXml } from 'xml-crypto';

const unescape = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (xml: string, name: string) =>
  new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(xml)?.[1];

interface StoredNfse {
  number: string;
  verificationCode: string;
  rps: { number: string; series: string };
  amount: string;
  cpf?: string;
  name?: string;
  cancelled: boolean;
}

/** Simula o webservice SOAP do Ginfes (v3): lote assíncrono, consultas e cancelamento. */
export class FakeGinfes {
  readonly received: { operation: string; args: string[] }[] = [];
  readonly nfses: StoredNfse[] = [];
  private readonly lotes = new Map<string, { rpsKey: string; polls: number }>();
  private server?: Server;
  /** Próxima recepção de lote responde com este erro (ex.: E35). */
  rejectNext?: { code: string; message: string };

  /** Nota emitida por outro sistema (ex.: eNotas), na série dele. */
  seedExternal(n: { number: string; amount: string; cpf?: string; name?: string; rps: string }) {
    this.nfses.push({
      number: n.number,
      verificationCode: `EXT${n.number}`,
      rps: { number: n.rps, series: '1' },
      amount: n.amount,
      cpf: n.cpf,
      name: n.name,
      cancelled: false,
    });
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/ServiceGinfesImpl`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const operation =
      /<ns1:(\w+) xmlns:ns1="http:\/\/producao\.ginfes\.com\.br">/.exec(raw)?.[1] ?? '';
    const args = [...raw.matchAll(/<arg\d>([\s\S]*?)<\/arg\d>/g)].map((m) => unescape(m[1]));
    this.received.push({ operation, args });
    const data = args.at(-1) ?? '';
    let body: string;
    if (!this.validSignature(data)) {
      body = this.errors('Resposta', 'E1', 'Assinatura do Hash não confere');
    } else {
      body = this.handle(operation, data);
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(
      `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:${operation}Response xmlns:ns2="http://producao.ginfes.com.br"><return>${escape(body)}</return></ns2:${operation}Response></S:Body></S:Envelope>`
    );
  }

  private validSignature(xml: string): boolean {
    const signature = /<Signature[\s\S]*?<\/Signature>/.exec(xml)?.[0];
    if (!signature) return false;
    const cert = /<X509Certificate>([^<]+)</.exec(signature)![1];
    const sig = new SignedXml({
      publicCert: `-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`,
    });
    sig.loadSignature(signature);
    try {
      return sig.checkSignature(xml);
    } catch {
      return false;
    }
  }

  private handle(operation: string, data: string): string {
    switch (operation) {
      case 'RecepcionarLoteRpsV3': {
        if (this.rejectNext) {
          const { code, message } = this.rejectNext;
          this.rejectNext = undefined;
          const protocolo = `P${this.lotes.size + 1}`;
          this.lotes.set(protocolo, { rpsKey: `ERR:${code}:${message}`, polls: 0 });
          return `<ns3:EnviarLoteRpsResposta xmlns:ns3="x"><ns3:Protocolo>${protocolo}</ns3:Protocolo></ns3:EnviarLoteRpsResposta>`;
        }
        const rps = { number: tag(data, 'Numero')!, series: tag(data, 'Serie')! };
        if (this.findRps(rps))
          return this.errors('EnviarLoteRpsResposta', 'E10', 'RPS já informado');
        this.nfses.push({
          number: String(1000 + this.nfses.length + 1),
          verificationCode: `VER${this.nfses.length + 1}X`,
          rps,
          amount: tag(data, 'ValorServicos')!,
          cpf: tag(data, 'Cpf'),
          name: tag(data, 'RazaoSocial'),
          cancelled: false,
        });
        const protocolo = `P${this.lotes.size + 1}`;
        this.lotes.set(protocolo, { rpsKey: `${rps.number}/${rps.series}`, polls: 0 });
        return `<ns3:EnviarLoteRpsResposta xmlns:ns3="x"><ns3:NumeroLote>${rps.number}</ns3:NumeroLote><ns3:Protocolo>${protocolo}</ns3:Protocolo></ns3:EnviarLoteRpsResposta>`;
      }
      case 'ConsultarSituacaoLoteRpsV3': {
        const lote = this.lotes.get(tag(data, 'Protocolo')!)!;
        lote.polls++;
        const situacao = lote.polls < 2 ? 2 : lote.rpsKey.startsWith('ERR') ? 3 : 4;
        return `<ns3:ConsultarSituacaoLoteRpsResposta xmlns:ns3="x"><ns3:Situacao>${situacao}</ns3:Situacao></ns3:ConsultarSituacaoLoteRpsResposta>`;
      }
      case 'ConsultarLoteRpsV3': {
        const lote = this.lotes.get(tag(data, 'Protocolo')!)!;
        if (lote.rpsKey.startsWith('ERR')) {
          const [, code, message] = lote.rpsKey.split(':');
          return this.errors('ConsultarLoteRpsResposta', code, message);
        }
        const [number, series] = lote.rpsKey.split('/');
        return `<ns3:ConsultarLoteRpsResposta xmlns:ns3="x"><ns3:ListaNfse>${this.comp(this.findRps({ number, series })!)}</ns3:ListaNfse></ns3:ConsultarLoteRpsResposta>`;
      }
      case 'ConsultarNfsePorRpsV3': {
        const found = this.findRps({ number: tag(data, 'Numero')!, series: tag(data, 'Serie')! });
        return found
          ? `<ns3:ConsultarNfseResposta xmlns:ns3="x">${this.comp(found)}</ns3:ConsultarNfseResposta>`
          : this.errors(
              'ConsultarNfseRpsResposta',
              'E4',
              'Esse RPS não foi encontrado em nossa base de dados'
            );
      }
      case 'ConsultarNfseV3': {
        const number = /<NumeroNfse>(\d+)<\/NumeroNfse>/.exec(data)?.[1];
        const list = this.nfses.filter((n) => !number || n.number === number);
        if (!list.length)
          return this.errors('ConsultarNfseResposta', 'E81', 'Não foi encontrada nenhuma NFS-e');
        return `<ns3:ConsultarNfseResposta xmlns:ns3="x"><ns3:ListaNfse>${list.map((n) => this.comp(n)).join('')}</ns3:ListaNfse></ns3:ConsultarNfseResposta>`;
      }
      case 'CancelarNfseV3': {
        const nfse = this.nfses.find((n) => n.number === tag(data, 'Numero'));
        if (!nfse) return this.errors('CancelarNfseResposta', 'E79', 'NFS-e não encontrada');
        nfse.cancelled = true;
        return `<ns3:CancelarNfseResposta xmlns:ns3="x"><ns3:Cancelamento><ns4:Confirmacao xmlns:ns4="y"><ns4:InfConfirmacaoCancelamento><ns4:Sucesso>true</ns4:Sucesso></ns4:InfConfirmacaoCancelamento></ns4:Confirmacao></ns3:Cancelamento></ns3:CancelarNfseResposta>`;
      }
      default:
        return this.errors('Resposta', 'E185', `Operação desconhecida ${operation}`);
    }
  }

  private findRps(rps: { number: string; series: string }) {
    return this.nfses.find((n) => n.rps.number === rps.number && n.rps.series === rps.series);
  }

  private comp(n: StoredNfse): string {
    const tomador = `<ns4:TomadorServico>${n.cpf ? `<ns4:IdentificacaoTomador><ns4:CpfCnpj><ns4:Cpf>${n.cpf}</ns4:Cpf></ns4:CpfCnpj></ns4:IdentificacaoTomador>` : ''}${n.name ? `<ns4:RazaoSocial>${n.name}</ns4:RazaoSocial>` : ''}</ns4:TomadorServico>`;
    return `<ns4:CompNfse xmlns:ns4="http://www.ginfes.com.br/tipos_v03.xsd"><ns4:Nfse><ns4:InfNfse><ns4:Numero>${n.number}</ns4:Numero><ns4:CodigoVerificacao>${n.verificationCode}</ns4:CodigoVerificacao><ns4:DataEmissao>2026-10-19T10:15:00</ns4:DataEmissao><ns4:IdentificacaoRps><ns4:Numero>${n.rps.number}</ns4:Numero><ns4:Serie>${n.rps.series}</ns4:Serie><ns4:Tipo>1</ns4:Tipo></ns4:IdentificacaoRps><ns4:Servico><ns4:Valores><ns4:ValorServicos>${n.amount}</ns4:ValorServicos><ns4:BaseCalculo>${n.amount}</ns4:BaseCalculo><ns4:Aliquota>0.0201</ns4:Aliquota></ns4:Valores><ns4:CodigoTributacaoMunicipio>8.02/103911/1551</ns4:CodigoTributacaoMunicipio></ns4:Servico><ns4:PrestadorServico><ns4:RazaoSocial>Empresa E2E LTDA</ns4:RazaoSocial></ns4:PrestadorServico>${tomador}</ns4:InfNfse></ns4:Nfse>${n.cancelled ? '<ns4:NfseCancelamento/>' : ''}</ns4:CompNfse>`;
  }

  private errors(root: string, code: string, message: string): string {
    return `<ns3:${root} xmlns:ns3="x" xmlns:ns4="y"><ns3:ListaMensagemRetorno><ns4:MensagemRetorno><ns4:Codigo>${code}</ns4:Codigo><ns4:Mensagem>${message}</ns4:Mensagem></ns4:MensagemRetorno></ns3:ListaMensagemRetorno></ns3:${root}>`;
  }
}
