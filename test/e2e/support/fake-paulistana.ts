import { createVerify } from 'node:crypto';
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
  new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(xml)?.[1];

interface StoredNFe {
  number: string;
  verificationCode: string;
  ccm: string;
  rps: { series: string; number: string };
  date: string;
  amount: string;
  code: string;
  rate: string;
  cpf?: string;
  cnpj?: string;
  name?: string;
  description: string;
  cancelled: boolean;
}

/**
 * Simula o web service da NFS-e Paulistana (lotenfe.asmx, leiaute 1): confere a XMLDSig da mensagem
 * e a assinatura do RPS (string de 86 posições), emite na hora, consulta e cancela.
 */
export class FakePaulistana {
  readonly received: { operation: string; soapAction: string; message: string }[] = [];
  readonly nfes: StoredNFe[] = [];
  /** Próximo EnvioRPS responde com este erro (ex.: 306 código de serviço inválido). */
  rejectNext?: { code: string; message: string };
  private server?: Server;

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/lotenfe.asmx`;
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
      /<(\w+)Request xmlns="http:\/\/www\.prefeitura\.sp\.gov\.br\/nfe">/.exec(raw)?.[1] ?? '';
    const message = unescape(/<MensagemXML>([\s\S]*?)<\/MensagemXML>/.exec(raw)?.[1] ?? '');
    this.received.push({ operation, soapAction: String(req.headers.soapaction ?? ''), message });
    const body = this.validSignature(message)
      ? this.handle(operation, message)
      : this.retorno('RetornoEnvioRPS', false, this.erro('1057', 'Assinatura difere do calculado'));
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end(
      `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operation}Response xmlns="http://www.prefeitura.sp.gov.br/nfe"><RetornoXML>${escape(body)}</RetornoXML></${operation}Response></soap:Body></soap:Envelope>`
    );
  }

  private validSignature(xml: string): boolean {
    const signature = /<Signature[\s\S]*?<\/Signature>/.exec(xml)?.[0];
    if (!signature) return false;
    const cert = /<X509Certificate>([^<]+)</.exec(signature)![1];
    const sig = new SignedXml({ publicCert: this.pem(cert) });
    sig.loadSignature(signature);
    try {
      return sig.checkSignature(xml);
    } catch {
      return false;
    }
  }

  private pem = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;

  private retorno = (root: string, ok: boolean, inner = '') =>
    `<${root} xmlns="http://www.prefeitura.sp.gov.br/nfe"><Cabecalho Versao="1" xmlns=""><Sucesso>${ok}</Sucesso></Cabecalho>${inner}</${root}>`;
  private erro = (code: string, message: string) =>
    `<Erro xmlns=""><Codigo>${code}</Codigo><Descricao>${message}</Descricao></Erro>`;

  /** String de 86 posições recalculada a partir do XML, como a prefeitura faz. */
  private rpsString(xml: string): string {
    const doc = /<CPF>(\d+)<\/CPF>/.exec(xml.split('<CPFCNPJTomador>')[1] ?? '')?.[1];
    const cnpj = /<CNPJ>(\d+)<\/CNPJ>/.exec(xml.split('<CPFCNPJTomador>')[1] ?? '')?.[1];
    const hasTomador = xml.includes('<CPFCNPJTomador>');
    const cents = (v: string) => {
      const [i, d = ''] = v.split('.');
      return String(Number(i) * 100 + Number(d.padEnd(2, '0'))).padStart(15, '0');
    };
    return [
      tag(xml, 'InscricaoPrestador')!.padStart(8, '0'),
      tag(xml, 'SerieRPS')!.padEnd(5, ' '),
      tag(xml, 'NumeroRPS')!.padStart(12, '0'),
      tag(xml, 'DataEmissao')!.replace(/-/g, ''),
      tag(xml, 'TributacaoRPS'),
      tag(xml, 'StatusRPS'),
      tag(xml, 'ISSRetido') === 'true' ? 'S' : 'N',
      cents(tag(xml, 'ValorServicos')!),
      cents(tag(xml, 'ValorDeducoes')!),
      tag(xml, 'CodigoServico')!.padStart(5, '0'),
      !hasTomador ? '3' : doc ? '1' : '2',
      (hasTomador ? (doc ?? cnpj!) : '').padStart(14, '0'),
    ].join('');
  }

  private handle(operation: string, xml: string): string {
    switch (operation) {
      case 'EnvioRPS': {
        const cert = /<X509Certificate>([^<]+)</.exec(xml)![1];
        const ok = createVerify('RSA-SHA1')
          .update(this.rpsString(xml), 'ascii')
          .verify(this.pem(cert), tag(xml, 'Assinatura')!, 'base64');
        if (!ok)
          return this.retorno(
            'RetornoEnvioRPS',
            false,
            this.erro('1206', 'Assinatura do RPS incorreta')
          );
        if (this.rejectNext) {
          const { code, message } = this.rejectNext;
          this.rejectNext = undefined;
          return this.retorno('RetornoEnvioRPS', false, this.erro(code, message));
        }
        const rps = { series: tag(xml, 'SerieRPS')!, number: tag(xml, 'NumeroRPS')! };
        let nfe = this.nfes.find((n) => n.rps.series === rps.series && n.rps.number === rps.number);
        if (!nfe) {
          const tomador = xml.split('<CPFCNPJTomador>')[1] ?? '';
          nfe = {
            number: String(9000 + this.nfes.length + 1),
            verificationCode: `SPV${String(this.nfes.length + 1).padStart(5, '0')}`,
            ccm: tag(xml, 'InscricaoPrestador')!,
            rps,
            date: tag(xml, 'DataEmissao')!,
            amount: tag(xml, 'ValorServicos')!,
            code: tag(xml, 'CodigoServico')!,
            rate: tag(xml, 'AliquotaServicos')!,
            cpf: /<CPF>(\d+)<\/CPF>/.exec(tomador)?.[1],
            cnpj: /<CNPJ>(\d+)<\/CNPJ>/.exec(tomador)?.[1],
            name: tag(xml, 'RazaoSocialTomador'),
            description: tag(xml, 'Discriminacao') ?? '',
            cancelled: false,
          };
          this.nfes.push(nfe);
        }
        return this.retorno(
          'RetornoEnvioRPS',
          true,
          `<ChaveNFeRPS xmlns=""><ChaveNFe><InscricaoPrestador>${nfe.ccm}</InscricaoPrestador><NumeroNFe>${nfe.number}</NumeroNFe><CodigoVerificacao>${nfe.verificationCode}</CodigoVerificacao></ChaveNFe><ChaveRPS><InscricaoPrestador>${nfe.ccm}</InscricaoPrestador><SerieRPS>${nfe.rps.series}</SerieRPS><NumeroRPS>${nfe.rps.number}</NumeroRPS></ChaveRPS></ChaveNFeRPS>`
        );
      }
      case 'ConsultaNFe': {
        const number = tag(xml, 'NumeroNFe');
        const series = tag(xml, 'SerieRPS');
        const rpsNumber = tag(xml, 'NumeroRPS');
        const found = this.nfes.find((n) =>
          number ? n.number === number : n.rps.series === series && n.rps.number === rpsNumber
        );
        return found
          ? this.retorno('RetornoConsulta', true, this.nfeXml(found))
          : this.retorno('RetornoConsulta', false, this.erro('1106', 'NF-e não encontrada'));
      }
      case 'ConsultaNFeEmitidas': {
        const from = tag(xml, 'dtInicio')!;
        const to = tag(xml, 'dtFim')!;
        const list = this.nfes.filter((n) => n.date >= from && n.date <= to);
        return this.retorno('RetornoConsulta', true, list.map((n) => this.nfeXml(n)).join(''));
      }
      case 'CancelamentoNFe': {
        const found = this.nfes.find((n) => n.number === tag(xml, 'NumeroNFe'));
        if (!found)
          return this.retorno(
            'RetornoCancelamentoNFe',
            false,
            this.erro('1106', 'NF-e não encontrada')
          );
        found.cancelled = true;
        return this.retorno('RetornoCancelamentoNFe', true);
      }
      default:
        return this.retorno(
          'RetornoConsulta',
          false,
          this.erro('1000', `Método ${operation} não simulado`)
        );
    }
  }

  private nfeXml(n: StoredNFe): string {
    const tomador = n.cpf
      ? `<CPFCNPJTomador><CPF>${n.cpf}</CPF></CPFCNPJTomador>`
      : n.cnpj
        ? `<CPFCNPJTomador><CNPJ>${n.cnpj}</CNPJ></CPFCNPJTomador>`
        : '';
    return `<NFe xmlns=""><ChaveNFe><InscricaoPrestador>${n.ccm}</InscricaoPrestador><NumeroNFe>${n.number}</NumeroNFe><CodigoVerificacao>${n.verificationCode}</CodigoVerificacao></ChaveNFe><DataEmissaoNFe>${n.date}T12:00:00</DataEmissaoNFe><DataFatoGeradorNFe>${n.date}T00:00:00</DataFatoGeradorNFe><ChaveRPS><InscricaoPrestador>${n.ccm}</InscricaoPrestador><SerieRPS>${n.rps.series}</SerieRPS><NumeroRPS>${n.rps.number}</NumeroRPS></ChaveRPS><CPFCNPJPrestador><CNPJ>11222333000181</CNPJ></CPFCNPJPrestador><RazaoSocialPrestador>EMPRESA E2E LTDA</RazaoSocialPrestador><EnderecoPrestador><Logradouro>PAULISTA</Logradouro><NumeroEndereco>1000</NumeroEndereco><Bairro>BELA VISTA</Bairro><Cidade>3550308</Cidade><UF>SP</UF></EnderecoPrestador><StatusNFe>${n.cancelled ? 'C' : 'N'}</StatusNFe><TributacaoNFe>T</TributacaoNFe><OpcaoSimples>4</OpcaoSimples><ValorServicos>${n.amount}</ValorServicos><CodigoServico>${n.code}</CodigoServico><AliquotaServicos>${n.rate}</AliquotaServicos><ValorISS>0</ValorISS><ValorCredito>0</ValorCredito><ISSRetido>false</ISSRetido>${tomador}${n.name ? `<RazaoSocialTomador>${n.name}</RazaoSocialTomador>` : ''}<Discriminacao>${n.description}</Discriminacao></NFe>`;
  }
}
