import { beforeEach, describe, expect, it } from 'vitest';
import { makeInvoice, makeTenant, NOW } from '../../../../../test/support/fixtures.js';
import { FixedClock, SilentLogger } from '../../../../../test/support/in-memory.js';
import { generateTestPfx } from '../../../../../test/support/test-certificate.js';
import { FiscalProviderUnavailableError } from '../../../../application/ports/fiscal-provider.js';
import { createTaxProfile } from '../../../../domain/product/tax-profile.js';
import { HttpResponse, MtlsHttpClient, TransportError } from './mtls-http.js';
import { NacionalFiscalProvider, parseSefinErrors } from './nacional-fiscal-provider.js';
import { gunzipBase64, gzipBase64, parseNfseXml, summarizeNfseXml } from './nfse-xml-parser.js';

const KEY = '35487082211222333000181000000000000126100000000017'.slice(0, 50);
const nfseXml = (key = KEY) =>
  `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${key}"><xLocEmi>São Bernardo do Campo</xLocEmi><nNFSe>17</nNFSe><xTribNac>Suporte técnico</xTribNac><dhProc>2026-10-18T10:00:05-03:00</dhProc><emit><xNome>EMPRESA</xNome></emit><valores><vBC>1500.00</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>30.00</vISSQN><vLiq>1500.00</vLiq></valores></infNFSe></NFSe>`;

class FakeHttp implements MtlsHttpClient {
  readonly calls: { method: string; url: string; body?: unknown }[] = [];
  responses: (HttpResponse | Error)[] = [];
  async request(
    method: 'GET' | 'POST' | 'HEAD',
    url: string,
    _c: unknown,
    body?: unknown
  ): Promise<HttpResponse> {
    this.calls.push({ method, url, body });
    const next = this.responses.shift() ?? { status: 500, body: {}, raw: '' };
    if (next instanceof Error) throw next;
    return next;
  }
}

const ok = (body: unknown, status = 201): HttpResponse => ({
  status,
  body,
  raw: JSON.stringify(body),
});
const cert = generateTestPfx();
const material = { pfx: cert.pfx, password: cert.password };

describe('NacionalFiscalProvider', () => {
  let http: FakeHttp;
  let provider: NacionalFiscalProvider;
  const tenant = makeTenant();

  beforeEach(() => {
    http = new FakeHttp();
    provider = new NacionalFiscalProvider({
      http,
      clock: new FixedClock(NOW),
      logger: new SilentLogger(),
      appVersion: 'test',
      breakerOptions: { volumeThreshold: 2, errorThresholdPercentage: 50, resetTimeout: 60_000 },
    });
  });

  it('envia DPS assinado, gzip+base64, para a produção restrita e lê a NFS-e', async () => {
    http.responses = [ok({ chaveAcesso: KEY, nfseXmlGZipB64: gzipBase64(nfseXml()) })];
    const outcome = await provider.issue(makeInvoice(), tenant, material);
    expect(outcome).toMatchObject({ kind: 'ISSUED', nfse: { number: '17', accessKey: KEY } });
    expect(http.calls[0].url).toBe('https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse');
    const dps = gunzipBase64((http.calls[0].body as { dpsXmlGZipB64: string }).dpsXmlGZipB64);
    expect(dps).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
  });

  it('usa produção quando a empresa está em PRODUCTION e busca o XML se não vier na resposta', async () => {
    http.responses = [ok({ chaveAcesso: KEY }), ok({ nfseXmlGZipB64: gzipBase64(nfseXml()) }, 200)];
    const outcome = await provider.issue(
      makeInvoice(),
      makeTenant({ environment: 'PRODUCTION' }),
      material
    );
    expect(outcome.kind).toBe('ISSUED');
    expect(http.calls.map((c) => c.url)).toEqual([
      'https://sefin.nfse.gov.br/SefinNacional/nfse',
      `https://sefin.nfse.gov.br/SefinNacional/nfse/${KEY}`,
    ]);
  });

  it('rejeição 400 vira REJECTED; mensagem de DPS duplicado vira DUPLICATE', async () => {
    http.responses = [
      ok({ erros: [{ Codigo: 'E0625', Descricao: 'pAliq não deve ser informada' }] }, 400),
    ];
    expect(await provider.issue(makeInvoice(), tenant, material)).toEqual({
      kind: 'REJECTED',
      errors: [{ code: 'E0625', message: 'pAliq não deve ser informada', complement: undefined }],
    });
    http.responses = [
      ok({ erro: { codigo: 'E0014', descricao: 'DPS já existente para o emitente' } }, 400),
    ];
    expect((await provider.issue(makeInvoice(), tenant, material)).kind).toBe('DUPLICATE');
    http.responses = [{ status: 403, body: undefined, raw: 'Forbidden' }];
    expect(await provider.issue(makeInvoice(), tenant, material)).toMatchObject({
      kind: 'REJECTED',
      errors: [{ code: 'HTTP_403' }],
    });
  });

  it('prévia devolve o DPS sem assinatura e sem chamar a Sefin', () => {
    const before = http.calls.length;
    const xml = provider.preview(makeInvoice(), makeTenant());
    expect(xml).toContain('<infDPS');
    expect(xml).not.toContain('Signature');
    expect(http.calls).toHaveLength(before);
  });

  it('validação local vira REJECTED sem chamar a Sefin', async () => {
    const invoice = makeInvoice({
      taxProfile: createTaxProfile({ nationalServiceCode: '010701', issRetention: 'TOMADOR' }),
    });
    expect(await provider.issue(invoice, tenant, material)).toMatchObject({
      kind: 'REJECTED',
      errors: [{ code: 'LOCAL_VALIDATION' }],
    });
    expect(http.calls).toHaveLength(0);
  });

  it('5xx, 429 e erro de transporte são indisponibilidade; o circuito abre e falha rápido', async () => {
    http.responses = [{ status: 503, body: undefined, raw: '' }, new TransportError('ECONNRESET')];
    await expect(provider.issue(makeInvoice(), tenant, material)).rejects.toBeInstanceOf(
      FiscalProviderUnavailableError
    );
    await expect(provider.issue(makeInvoice(), tenant, material)).rejects.toBeInstanceOf(
      FiscalProviderUnavailableError
    );
    const before = http.calls.length;
    await expect(provider.issue(makeInvoice(), tenant, material)).rejects.toThrow(
      /circuit breaker|indisponível|open/i
    );
    expect(http.calls.length).toBe(before);
  });

  it('consulta pelo id do DPS (idempotência)', async () => {
    http.responses = [
      ok({ chaveAcesso: KEY }, 200),
      ok({ nfseXmlGZipB64: gzipBase64(nfseXml()) }, 200),
    ];
    expect((await provider.findByDpsId(makeInvoice(), tenant, material))!.number).toBe('17');
    expect(http.calls[0].url).toMatch(/\/dps\/DPS3548708/);
    http.responses = [{ status: 404, body: undefined, raw: '' }];
    expect(await provider.findByDpsId(makeInvoice(), tenant, material)).toBeNull();
  });

  it('cancela via evento 101101', async () => {
    const invoice = makeInvoice({ status: 'ISSUED', nfse: parseNfseXml(nfseXml()) });
    http.responses = [ok({ eventoXmlGZipB64: 'x' })];
    expect(
      await provider.cancel(invoice, tenant, material, {
        code: '1',
        description: 'Erro no valor do serviço',
      })
    ).toEqual({ ok: true });
    expect(http.calls[0].url).toBe(
      `https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse/${KEY}/eventos`
    );
    const xml = gunzipBase64(
      (http.calls[0].body as { pedidoRegistroEventoXmlGZipB64: string })
        .pedidoRegistroEventoXmlGZipB64
    );
    expect(xml).toContain(`Id="PRE${KEY}101101"`);

    http.responses = [ok({ erros: [{ Codigo: 'E1', Descricao: 'Prazo expirado' }] }, 400)];
    expect(
      await provider.cancel(invoice, tenant, material, {
        code: '1',
        description: 'Erro no valor do serviço',
      })
    ).toMatchObject({ ok: false });
    expect(
      await provider.cancel(makeInvoice(), tenant, material, {
        code: '1',
        description: 'Erro no valor do serviço',
      })
    ).toMatchObject({ ok: false });
  });

  it('consulta alíquota municipal na ADN', async () => {
    http.responses = [ok({ aliquotas: { '01.07.01.000': [{ Aliq: 2.5 }] } }, 200)];
    const params = await provider.get('3548708', '010701', NOW, { tenant, certificate: material });
    expect(params!.issRateBps).toBe(250);
    expect(http.calls[0].url).toBe(
      'https://adn.producaorestrita.nfse.gov.br/parametrizacao/3548708/01.07.01.000/2026-10-18/aliquota'
    );
    http.responses = [{ status: 404, body: undefined, raw: '' }];
    expect(
      await provider.get('3548708', '010701', NOW, { tenant, certificate: material })
    ).toBeNull();
  });
});

describe('parsers', () => {
  it('normaliza formatos de erro da Sefin', () => {
    expect(
      parseSefinErrors({ Erros: [{ codigo: 'E1', mensagem: 'm', complemento: 'c' }] })
    ).toEqual([{ code: 'E1', message: 'm', complement: 'c' }]);
    expect(parseSefinErrors({ Codigo: 'E2', Descricao: 'd' })).toEqual([
      { code: 'E2', message: 'd', complement: undefined },
    ]);
    expect(parseSefinErrors('html')).toEqual([]);
    expect(parseSefinErrors({})).toEqual([]);
  });

  it('extrai dados da NFS-e para o DANFSe', () => {
    expect(parseNfseXml(nfseXml())).toMatchObject({
      number: '17',
      verificationUrl: expect.stringContaining(KEY),
    });
    expect(summarizeNfseXml(nfseXml())).toMatchObject({
      issuerName: 'EMPRESA',
      issValue: '30.00',
      issRateText: '2.00',
      serviceName: 'Suporte técnico',
    });
    expect(() => parseNfseXml('<NFSe/>')).toThrow(/sem chave/);
  });
});

describe('leitura do DPS ecoado na NFS-e', () => {
  it('extrai valor e documento do tomador para conferência', () => {
    const withEcho = (toma: string) =>
      `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${KEY}"><nNFSe>1</nNFSe><DPS><infDPS Id="DPS1">${toma}<valores><vServPrest><vServ>1500.00</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`;
    expect(parseNfseXml(withEcho('<toma><CPF>52998224725</CPF></toma>'))).toMatchObject({
      amountCents: 150000,
      customerDocument: '52998224725',
    });
    expect(parseNfseXml(withEcho('<toma><NIF>X-1</NIF></toma>')).customerDocument).toBe('X-1');
    expect(parseNfseXml(withEcho('')).customerDocument).toBe('');
    expect(parseNfseXml(nfseXml())).toMatchObject({
      amountCents: undefined,
      customerDocument: undefined,
    });
  });

  describe('consulta na distribuição do ADN', () => {
    let http: FakeHttp;
    let provider: NacionalFiscalProvider;
    const tenant = makeTenant();

    beforeEach(() => {
      http = new FakeHttp();
      provider = new NacionalFiscalProvider({
        http,
        clock: new FixedClock(NOW),
        logger: new SilentLogger(),
        appVersion: 'test',
      });
    });

    const range = { from: new Date('2026-11-01T03:00:00Z'), to: new Date('2026-11-30T03:00:00Z') };
    const distributed = (key: string, number: string, prest: string, dhProc: string) =>
      `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS${key}"><nNFSe>${number}</nNFSe><dhProc>${dhProc}</dhProc><DPS><infDPS><serie>900</serie><nDPS>39</nDPS><prest><CNPJ>${prest}</CNPJ></prest><toma><CPF>52998224725</CPF><xNome>Bruno</xNome></toma><valores><vServPrest><vServ>1.00</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`;
    const nfseItem = (nsu: number, key: string, xml: string) => ({
      NSU: nsu,
      ChaveAcesso: key,
      TipoDocumento: 'NFSE',
      ArquivoXml: gzipBase64(xml),
    });
    const KEY_A = '1'.repeat(50);
    const KEY_B = '2'.repeat(50);
    const KEY_C = '3'.repeat(50);
    const KEY_D = '4'.repeat(50);

    it('percorre as páginas: só notas prestadas no período, com cancelamento efetivo', async () => {
      http.responses = [
        ok(
          {
            StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
            LoteDFe: [
              nfseItem(
                1,
                KEY_A,
                distributed(KEY_A, '23', tenant.cnpj, '2026-11-03T10:40:32-03:00')
              ),
              // Nota recebida pelo CNPJ, como tomador: não é faturamento.
              nfseItem(
                2,
                KEY_B,
                distributed(KEY_B, '7', '99888777000166', '2026-11-03T11:00:00-03:00')
              ),
            ],
          },
          200
        ),
        ok(
          {
            StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
            LoteDFe: [
              // Fora do período pedido.
              nfseItem(
                3,
                KEY_C,
                distributed(KEY_C, '22', tenant.cnpj, '2026-10-31T10:00:00-03:00')
              ),
              nfseItem(
                4,
                KEY_D,
                distributed(KEY_D, '24', tenant.cnpj, '2026-11-03T12:00:00-03:00')
              ),
              // Pedido em análise ainda não cancela; o deferimento cancela (XML sem compressão).
              {
                NSU: 5,
                ChaveAcesso: KEY_D,
                TipoDocumento: 'EVENTO',
                TipoEvento: 'SOLICITACAO_CANCELAMENTO_ANALISE_FISCAL',
              },
              {
                NSU: 6,
                ChaveAcesso: KEY_A,
                TipoDocumento: 'EVENTO',
                ArquivoXml: Buffer.from(
                  '<evento><infPedReg><e105104/></infPedReg></evento>'
                ).toString('base64'),
              },
            ],
          },
          200
        ),
        ok({ StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO' }, 404),
      ];

      const notes = await provider.listIssued(tenant, material, range);

      expect(notes.map((n) => [n.number, n.cancelled])).toEqual([
        ['23', true],
        ['24', false],
      ]);
      expect(notes[0]).toMatchObject({
        amountCents: 100,
        rps: { number: '39', series: '900' },
        customerDocument: '52998224725',
        customerName: 'Bruno',
      });
      expect(notes[0]).not.toHaveProperty('xml');
      expect(http.calls.map((c) => new URL(c.url).pathname)).toEqual([
        '/contribuintes/DFe/0',
        '/contribuintes/DFe/2',
        '/contribuintes/DFe/6',
      ]);
      expect(http.calls[0].url).toContain(`cnpjConsulta=${tenant.cnpj}&lote=true`);
    });

    it('nunca devolve lista parcial: limite do ADN ou rejeição viram erro', async () => {
      http.responses = [
        ok(
          {
            StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS',
            LoteDFe: [
              nfseItem(
                1,
                KEY_A,
                distributed(KEY_A, '23', tenant.cnpj, '2026-11-03T10:40:32-03:00')
              ),
            ],
          },
          200
        ),
        ok({}, 429),
      ];
      await expect(provider.listIssued(tenant, material, range)).rejects.toBeInstanceOf(
        FiscalProviderUnavailableError
      );

      http.responses = [ok({ StatusProcessamento: 'REJEICAO', Erros: [] }, 200)];
      await expect(provider.listIssued(tenant, material, range)).rejects.toThrow(/ADN/);
    });

    it('sem documentos: lista vazia e nota não encontrada', async () => {
      http.responses = [ok({}, 404), ok({}, 404)];
      expect(await provider.listIssued(tenant, material, range)).toEqual([]);
      expect(await provider.getIssued(tenant, material, '23')).toBeNull();
    });

    it('acha a nota pelo número, com o XML', async () => {
      const xml = distributed(KEY_A, '23', tenant.cnpj, '2026-11-03T10:40:32-03:00');
      http.responses = [
        ok(
          { StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [nfseItem(1, KEY_A, xml)] },
          200
        ),
        ok({}, 404),
      ];
      expect(await provider.getIssued(tenant, material, '23')).toMatchObject({ number: '23', xml });
    });
  });
});
