import {
  CertificateMaterial,
  FiscalProvider,
  FiscalProviderUnavailableError,
  IssueOutcome,
  MunicipalNfseSummary,
} from '../../../../application/ports/fiscal-provider.js';
import { FiscalError, Invoice, IssuedNfse } from '../../../../domain/invoice/invoice.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { openPfx } from '../../crypto/pfx.js';
import {
  buildCancelarV2,
  buildCancelarV3,
  buildConsultarLote,
  buildConsultarNfse,
  buildConsultarNfseRps,
  buildConsultarSituacaoLote,
  buildEnviarLoteRps,
  GINFES_CABECALHO,
  GinfesRtcGroup,
  ginfesMissingFields,
} from './ginfes-xml.js';
import {
  parseCancelarResposta,
  parseCompNfseList,
  parseEnviarLoteResposta,
  parseMessages,
  parseSituacaoLote,
  ParsedCompNfse,
  toIssuedNfse,
} from './ginfes-parser.js';
import { signCancelV3, signLote, signRoot } from './ginfes-signer.js';
import { GinfesTransport } from './ginfes-soap.js';

export interface GinfesConfig {
  productionUrl: string;
  homologationUrl: string;
  /** Modo piloto: cada nota espera aprovação antes de ir à prefeitura. */
  pilot: boolean;
  /** Esperas entre consultas da situação do lote (ms). Depois disso, a fila tenta de novo. */
  pollDelaysMs: number[];
  /**
   * Grupos da reforma tributária enviados (NBS, totTrib, IBS/CBS). SBC recusou o lote com os três
   * (E160, 19/10/2026): o XSD de produção não é público, então cada grupo é ligado por configuração.
   */
  rtcGroups?: GinfesRtcGroup[];
  /** Link de consulta pública da nota. */
  verificationUrl: (nfse: { number: string; verificationCode: string; cnpj: string }) => string;
}

/** "RPS já informado": o mesmo RPS já foi recebido antes (ex.: timeout após envio). */
const DUPLICATE_CODES = new Set(['E10']);
/**
 * "RPS não encontrado": não existe (ou ainda não foi processado). E4 é o código ABRASF; São
 * Bernardo responde E89 ("Não existe na base de dados uma NFS-e emitida para o número de RPS").
 */
const NOT_FOUND_CODES = new Set(['E4', 'E89']);
const isNotFound = (e: FiscalError): boolean =>
  NOT_FOUND_CODES.has(e.code) || /n[ãa]o (existe|foi encontrad|encontrad)/i.test(e.message);
/**
 * Cancelamento v3 recusado por estrutura (E160/E185) ou por município (E344 "Código do Município
 * difere do informado na nota", visto em SBC em 19/10/2026): tenta o v2, que não leva município.
 */
const SCHEMA_CODES = new Set(['E160', 'E185', 'E344']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SBC_VERIFICATION_URL = (n: { number: string; verificationCode: string }) =>
  `https://visualizar.isssbc.com.br/report/consultarNota?__report=nfs_ver4RT&cdVerificacao=${encodeURIComponent(n.verificationCode)}&numNota=${encodeURIComponent(n.number)}&cnpjPrestador=null`;

/**
 * Emissão pelo Ginfes (ABRASF v3), usado por São Bernardo do Campo para ME/EPP até a prefeitura
 * liberar o Emissor Nacional. Assíncrono: envia o lote, acompanha a situação e busca a nota.
 * Se o processamento demorar, lança indisponibilidade: a fila tenta de novo e, antes de reenviar,
 * consulta o RPS (findByDpsId) — o RPS é a chave de idempotência.
 */
export class GinfesFiscalProvider implements FiscalProvider {
  readonly name = 'GINFES';
  readonly requiresApproval: boolean;

  constructor(
    private readonly transport: GinfesTransport,
    private readonly config: GinfesConfig,
    private readonly clock: { now(): Date } = { now: () => new Date() }
  ) {
    this.requiresApproval = config.pilot;
  }

  private url(tenant: Tenant): string {
    return tenant.environment === 'PRODUCTION'
      ? this.config.productionUrl
      : this.config.homologationUrl;
  }

  preview(invoice: Invoice, tenant: Tenant): string {
    const missing = ginfesMissingFields(invoice, tenant);
    if (missing.length) return `<!-- Pendências: ${missing.join(' | ')} -->`;
    return buildEnviarLoteRps(invoice, tenant, this.clock.now(), this.config.rtcGroups ?? []);
  }

  async issue(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssueOutcome> {
    const missing = ginfesMissingFields(invoice, tenant);
    if (missing.length) {
      return {
        kind: 'REJECTED',
        errors: missing.map((message) => ({ code: 'GINFES_DADOS', message })),
      };
    }
    const pfx = openPfx(certificate.pfx, certificate.password);
    const lote = signLote(
      buildEnviarLoteRps(invoice, tenant, this.clock.now(), this.config.rtcGroups ?? []),
      pfx
    );
    const sent = parseEnviarLoteResposta(
      await this.transport.call(
        this.url(tenant),
        'RecepcionarLoteRpsV3',
        [GINFES_CABECALHO, lote],
        certificate
      )
    );
    if ('errors' in sent) return this.rejection(sent.errors);

    for (const delay of this.config.pollDelaysMs) {
      await sleep(delay);
      const situacao = parseSituacaoLote(
        await this.consult(
          tenant,
          certificate,
          'ConsultarSituacaoLoteRpsV3',
          buildConsultarSituacaoLote(tenant, sent.protocolo),
          'ConsultarSituacaoLoteRpsEnvio'
        )
      );
      if ('errors' in situacao) {
        // E178 "lote aguardando processamento" e afins: continua esperando.
        continue;
      }
      if (situacao.situacao === 3 || situacao.situacao === 4) {
        const loteXml = await this.consult(
          tenant,
          certificate,
          'ConsultarLoteRpsV3',
          buildConsultarLote(tenant, sent.protocolo),
          'ConsultarLoteRpsEnvio'
        );
        const [nfse] = parseCompNfseList(loteXml);
        if (nfse) return { kind: 'ISSUED', nfse: this.toIssued(nfse, tenant) };
        return this.rejection(parseMessages(loteXml));
      }
    }
    throw new FiscalProviderUnavailableError(
      `Lote ${sent.protocolo} ainda em processamento no Ginfes; a nota será consultada de novo`
    );
  }

  async findByDpsId(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssuedNfse | null> {
    const xml = await this.consult(
      tenant,
      certificate,
      'ConsultarNfsePorRpsV3',
      buildConsultarNfseRps(invoice, tenant),
      'ConsultarNfseRpsEnvio'
    );
    const [nfse] = parseCompNfseList(xml);
    if (nfse) return this.toIssued(nfse, tenant);
    const errors = parseMessages(xml);
    if (errors.length && !errors.every(isNotFound)) {
      throw new FiscalProviderUnavailableError(
        `Consulta do RPS no Ginfes falhou: ${errors.map((e) => `${e.code} ${e.message}`).join('; ')}`
      );
    }
    return null;
  }

  async cancel(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial,
    reason: { code: string; description: string }
  ): Promise<{ ok: true } | { ok: false; errors: FiscalError[] }> {
    if (!invoice.nfse)
      return { ok: false, errors: [{ code: 'GINFES', message: 'Nota sem número' }] };
    const pfx = openPfx(certificate.pfx, certificate.password);
    // Código ABRASF: 1 erro na emissão, 2 serviço não prestado, 4 duplicidade.
    const code = ['1', '2', '4'].includes(reason.code) ? reason.code : '2';
    const v3 = parseCancelarResposta(
      await this.transport.call(
        this.url(tenant),
        'CancelarNfseV3',
        [GINFES_CABECALHO, signCancelV3(buildCancelarV3(tenant, invoice.nfse.number, code), pfx)],
        certificate
      )
    );
    if (v3.ok || !v3.errors.some((e) => SCHEMA_CODES.has(e.code))) return v3;
    return parseCancelarResposta(
      await this.transport.call(
        this.url(tenant),
        'CancelarNfse',
        [signRoot(buildCancelarV2(tenant, invoice.nfse.number), 'CancelarNfseEnvio', pfx)],
        certificate
      )
    );
  }

  /**
   * Com a data de emissão, consulta o dia (mesmo caminho da listagem, que responde rápido) e filtra
   * pelo número. Só pelo número, o Ginfes de SBC chegou a não responder em 60 s (19/10/2026).
   */
  async getIssued(
    tenant: Tenant,
    certificate: CertificateMaterial,
    number: string,
    issuedOn?: Date
  ): Promise<(MunicipalNfseSummary & { xml: string }) | null> {
    const xml = await this.consult(
      tenant,
      certificate,
      'ConsultarNfseV3',
      buildConsultarNfse(tenant, issuedOn ? { from: issuedOn, to: issuedOn } : { number }),
      'ConsultarNfseEnvio'
    );
    const found = parseCompNfseList(xml).find((n) => n.number === number);
    if (found) return found;
    const errors = parseMessages(xml);
    if (
      errors.length &&
      !errors.every((e) => /n[ãa]o (foi )?encontrad|n[ãa]o existe/i.test(e.message))
    ) {
      throw new FiscalProviderUnavailableError(
        errors.map((e) => `${e.code} ${e.message}`).join('; ')
      );
    }
    return null;
  }

  async listIssued(
    tenant: Tenant,
    certificate: CertificateMaterial,
    range: { from: Date; to: Date }
  ): Promise<MunicipalNfseSummary[]> {
    const xml = await this.consult(
      tenant,
      certificate,
      'ConsultarNfseV3',
      buildConsultarNfse(tenant, range),
      'ConsultarNfseEnvio'
    );
    const list = parseCompNfseList(xml);
    if (!list.length) {
      const errors = parseMessages(xml);
      // Sem notas no período também volta como mensagem; só é erro se não for "não encontrado".
      if (errors.length && !errors.every((e) => /n[ãa]o (foi )?encontrad/i.test(e.message))) {
        throw new FiscalProviderUnavailableError(
          errors.map((e) => `${e.code} ${e.message}`).join('; ')
        );
      }
    }
    return list.map(({ xml: _xml, ...summary }) => summary);
  }

  private async consult(
    tenant: Tenant,
    certificate: CertificateMaterial,
    operation: string,
    xml: string,
    root: string
  ): Promise<string> {
    const signed = signRoot(xml, root, openPfx(certificate.pfx, certificate.password));
    return this.transport.call(
      this.url(tenant),
      operation,
      [GINFES_CABECALHO, signed],
      certificate
    );
  }

  private rejection(errors: FiscalError[]): IssueOutcome {
    return errors.some((e) => DUPLICATE_CODES.has(e.code))
      ? { kind: 'DUPLICATE', errors }
      : { kind: 'REJECTED', errors };
  }

  private toIssued(nfse: ParsedCompNfse, tenant: Tenant): IssuedNfse {
    return toIssuedNfse(
      nfse,
      this.config.verificationUrl({
        number: nfse.number,
        verificationCode: nfse.verificationCode,
        cnpj: tenant.cnpj,
      })
    );
  }
}
