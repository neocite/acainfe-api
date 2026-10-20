import { DOMParser } from '@xmldom/xmldom';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  gunzipBase64,
  gzipBase64,
} from '../../../src/adapters/out/fiscal/nacional/nfse-xml-parser.js';

export type SefinMode = 'OK' | 'DOWN' | 'REJECT';

interface Stored {
  dpsId: string;
  accessKey: string;
  number: number;
  nfseXml: string;
}

/**
 * Simula a Sefin Nacional sobre HTTP (sem mTLS) para os testes e2e:
 * recebe o DPS gzip+base64, devolve NFS-e autorizada, responde consultas por DPS/chave e eventos.
 */
export class FakeSefin {
  mode: SefinMode = 'OK';
  readonly received: { method: string; path: string; body?: unknown }[] = [];
  readonly dpsXmls: string[] = [];
  readonly events: string[] = [];
  private readonly byDps = new Map<string, Stored>();
  private readonly byKey = new Map<string, Stored>();
  private server?: Server;
  private seq = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  /** Simula uma nota já emitida por OUTRO sistema com o mesmo id de DPS (colisão de numeração). */
  preloadForeignNote(dpsId: string, amount: string, customerCpf: string): void {
    const number = ++this.seq;
    const accessKey = `3548708${'2'}${'2'}${dpsId.slice(11, 25)}${String(number).padStart(13, '0')}2610${'000000001'}${'7'}`;
    const nfseXml = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${accessKey}"><nNFSe>${number}</nNFSe><dhProc>2026-01-10T10:00:00-03:00</dhProc><DPS><infDPS Id="${dpsId}"><toma><CPF>${customerCpf}</CPF><xNome>Outro cliente</xNome></toma><valores><vServPrest><vServ>${amount}</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`;
    const stored = { dpsId, accessKey, number, nfseXml };
    this.byDps.set(dpsId, stored);
    this.byKey.set(accessKey, stored);
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
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(req.url!, 'http://x').pathname.replace(/^\/SefinNacional/, '');
    this.received.push({ method: req.method!, path, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (this.mode === 'DOWN') return send(503, { erro: 'Serviço indisponível' });

    if (req.method === 'POST' && path === '/nfse') {
      const xml = gunzipBase64(body.dpsXmlGZipB64);
      this.dpsXmls.push(xml);
      if (this.mode === 'REJECT') {
        return send(400, {
          erros: [
            {
              Codigo: 'E0625',
              Descricao: 'Alíquota do ISSQN não deve ser informada',
              Complemento: 'pAliq',
            },
          ],
        });
      }
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const inf = doc.getElementsByTagNameNS('*', 'infDPS')[0];
      const dpsId = inf.getAttribute('Id')!;
      const existing = this.byDps.get(dpsId);
      if (existing)
        return send(400, { erros: [{ Codigo: 'E0014', Descricao: 'DPS já existente na base' }] });
      const number = ++this.seq;
      const accessKey = `3548708${'2'}${'2'}${dpsId.slice(11, 25)}${String(number).padStart(13, '0')}2610${'000000001'}${'7'}`;
      const nfseXml = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${accessKey}"><xLocEmi>São Bernardo do Campo</xLocEmi><nNFSe>${number}</nNFSe><xTribNac>Serviço</xTribNac><dhProc>2026-10-18T10:00:00-03:00</dhProc><emit><xNome>EMPRESA TESTE LTDA</xNome></emit><valores><vLiq>0.00</vLiq></valores>${xml.replace(/^<\?xml[^>]*\?>/, '')}</infNFSe></NFSe>`;
      const stored = { dpsId, accessKey, number, nfseXml };
      this.byDps.set(dpsId, stored);
      this.byKey.set(accessKey, stored);
      return send(201, {
        tipoAmbiente: 2,
        idDps: dpsId,
        chaveAcesso: accessKey,
        nfseXmlGZipB64: gzipBase64(nfseXml),
      });
    }

    const dps = path.match(/^\/dps\/(.+)$/);
    if (req.method === 'GET' && dps) {
      const s = this.byDps.get(dps[1]);
      return s ? send(200, { idDps: s.dpsId, chaveAcesso: s.accessKey }) : send(404, {});
    }
    const event = path.match(/^\/nfse\/(\d{50})\/eventos$/);
    if (req.method === 'POST' && event) {
      this.events.push(gunzipBase64(body.pedidoRegistroEventoXmlGZipB64));
      return send(201, { eventoXmlGZipB64: gzipBase64('<evento/>') });
    }
    const nfse = path.match(/^\/nfse\/(\d{50})$/);
    if (req.method === 'GET' && nfse) {
      const s = this.byKey.get(nfse[1]);
      return s
        ? send(200, { chaveAcesso: s.accessKey, nfseXmlGZipB64: gzipBase64(s.nfseXml) })
        : send(404, {});
    }
    const aliquota = path.match(/^\/parametrizacao\/(\d+)\/([\d.]+)\/[^/]+\/aliquota$/);
    if (req.method === 'GET' && aliquota) {
      return send(200, { aliquotas: { [aliquota[2]]: [{ Aliq: 2.0, DtIni: '2026-01-01' }] } });
    }
    send(404, { erro: `rota fake inexistente: ${req.method} ${path}` });
  }
}
