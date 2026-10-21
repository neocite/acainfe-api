import {
  CertificateMaterial,
  FiscalProvider,
  FiscalProviderUnavailableError,
  IssueOutcome,
  MunicipalNfseSummary,
} from '../../../../application/ports/fiscal-provider.js';
import { FiscalError, Invoice, IssuedNfse } from '../../../../domain/invoice/invoice.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { openPfx, PfxContents } from '../../crypto/pfx.js';
import { signEnvelopedSha1 } from '../shared/xmldsig.js';
import {
  isSuccess,
  ParsedNFe,
  parseEnvioRps,
  parseEvents,
  parseNFeList,
  toIssuedNfse,
} from './paulistana-parser.js';
import { PaulistanaOperation, PaulistanaTransport } from './paulistana-soap.js';
import {
  buildPedidoCancelamento,
  buildPedidoConsultaEmitidas,
  buildPedidoConsultaNFe,
  buildPedidoEnvioRps,
  inscricaoPrestador,
  paulistanaMissingFields,
  rpsKey,
} from './paulistana-xml.js';

export interface PaulistanaConfig {
  url: string;
  /** Modo piloto: cada nota espera aprovação antes de ir à prefeitura. */
  pilot: boolean;
}

/** 1106 = NF-e/RPS não encontrado. */
const isNotFound = (e: FiscalError): boolean =>
  e.code === '1106' || /n[ãa]o (foi )?encontrad|inexistente/i.test(e.message);
/** 1301 = NF-e já cancelada: o cancelamento já está feito. */
const ALREADY_CANCELLED = '1301';
/** Consulta por período: no máximo 31 dias por chamada, 50 notas por página. */
const MAX_RANGE_MS = 30 * 86_400_000;
const PAGE_SIZE = 50;

export const SP_VERIFICATION_URL = (n: { number: string; verificationCode: string; ccm: string }) =>
  `https://nfe.prefeitura.sp.gov.br/contribuinte/notaprint.aspx?ccm=${encodeURIComponent(n.ccm)}&nf=${encodeURIComponent(n.number)}&cod=${encodeURIComponent(n.verificationCode.replace(/-/g, ''))}`;

/**
 * Emissão pela NFS-e Paulistana (web service síncrono, leiaute 1), usada por ME/EPP da capital até
 * a migração para o Emissor Nacional. O EnvioRPS devolve o número da nota na hora; antes de reenviar
 * após um timeout, a fila consulta pelo RPS (findByDpsId) — o RPS é a chave de idempotência.
 * São Paulo não tem ambiente de homologação: só produção.
 */
export class PaulistanaFiscalProvider implements FiscalProvider {
  readonly name = 'PAULISTANA';
  readonly requiresApproval: boolean;

  constructor(
    private readonly transport: PaulistanaTransport,
    private readonly config: PaulistanaConfig
  ) {
    this.requiresApproval = config.pilot;
  }

  preview(invoice: Invoice, tenant: Tenant): string {
    const missing = paulistanaMissingFields(invoice, tenant);
    if (missing.length) return `<!-- Pendências: ${missing.join(' | ')} -->`;
    return buildPedidoEnvioRps(invoice, tenant);
  }

  async issue(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssueOutcome> {
    const missing = paulistanaMissingFields(invoice, tenant);
    if (tenant.environment !== 'PRODUCTION') {
      missing.push(
        'A prefeitura de São Paulo não tem ambiente de homologação: a emissão só acontece em produção.'
      );
    }
    if (missing.length) {
      return {
        kind: 'REJECTED',
        errors: missing.map((message) => ({ code: 'PAULISTANA_DADOS', message })),
      };
    }
    const pfx = openPfx(certificate.pfx, certificate.password);
    const sent = parseEnvioRps(
      await this.signedCall(
        'EnvioRPS',
        buildPedidoEnvioRps(invoice, tenant, pfx),
        'PedidoEnvioRPS',
        pfx,
        certificate
      )
    );
    if ('errors' in sent) return { kind: 'REJECTED', errors: sent.errors };
    // O retorno traz só a chave: busca a nota completa (PDF e conferência). Se a consulta falhar,
    // a nota já existe — guarda a chave e segue.
    const full = await this.findNFe(tenant, certificate, pfx, { nfse: sent.number }).catch(
      () => null
    );
    return {
      kind: 'ISSUED',
      nfse: this.toIssued(
        full ?? {
          number: sent.number,
          verificationCode: sent.verificationCode,
          xml: '',
          amountCents: invoice.amountCents,
        },
        tenant
      ),
    };
  }

  async findByDpsId(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssuedNfse | null> {
    const pfx = openPfx(certificate.pfx, certificate.password);
    const nfe = await this.findNFe(tenant, certificate, pfx, { rps: rpsKey(invoice) });
    return nfe ? this.toIssued(nfe, tenant) : null;
  }

  async cancel(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<{ ok: true } | { ok: false; errors: FiscalError[] }> {
    if (!invoice.nfse)
      return { ok: false, errors: [{ code: 'PAULISTANA', message: 'Nota sem número' }] };
    const pfx = openPfx(certificate.pfx, certificate.password);
    const xml = await this.signedCall(
      'CancelamentoNFe',
      buildPedidoCancelamento(tenant, invoice.nfse.number, pfx),
      'PedidoCancelamentoNFe',
      pfx,
      certificate
    );
    const { errors, alerts } = parseEvents(xml);
    if (isSuccess(xml) || alerts.some((a) => a.code === ALREADY_CANCELLED)) {
      if (!errors.length) return { ok: true };
    }
    return {
      ok: false,
      errors: errors.length
        ? errors
        : [{ code: 'PAULISTANA', message: `Resposta inesperada: ${xml.slice(0, 300)}` }],
    };
  }

  async getIssued(
    tenant: Tenant,
    certificate: CertificateMaterial,
    number: string
  ): Promise<(MunicipalNfseSummary & { xml: string }) | null> {
    const pfx = openPfx(certificate.pfx, certificate.password);
    return this.findNFe(tenant, certificate, pfx, { nfse: number });
  }

  async listIssued(
    tenant: Tenant,
    certificate: CertificateMaterial,
    range: { from: Date; to: Date }
  ): Promise<MunicipalNfseSummary[]> {
    const pfx = openPfx(certificate.pfx, certificate.password);
    const found: MunicipalNfseSummary[] = [];
    for (
      let start = range.from.getTime();
      start <= range.to.getTime();
      start += MAX_RANGE_MS + 86_400_000
    ) {
      const window = {
        from: new Date(start),
        to: new Date(Math.min(start + MAX_RANGE_MS, range.to.getTime())),
      };
      for (let page = 1; ; page++) {
        const xml = await this.signedCall(
          'ConsultaNFeEmitidas',
          buildPedidoConsultaEmitidas(tenant, window, page),
          'PedidoConsultaNFePeriodo',
          pfx,
          certificate
        );
        const list = parseNFeList(xml);
        this.throwOnErrors(xml);
        found.push(...list.map(({ xml: _xml, ...summary }) => summary));
        if (list.length < PAGE_SIZE) break;
      }
    }
    return found;
  }

  /** NFS-e pela chave do RPS ou pelo número; null se a prefeitura não a encontrar. */
  private async findNFe(
    tenant: Tenant,
    certificate: CertificateMaterial,
    pfx: PfxContents,
    key: Parameters<typeof buildPedidoConsultaNFe>[1]
  ): Promise<ParsedNFe | null> {
    const xml = await this.signedCall(
      'ConsultaNFe',
      buildPedidoConsultaNFe(tenant, key),
      'PedidoConsultaNFe',
      pfx,
      certificate
    );
    const [nfe] = parseNFeList(xml);
    if (nfe) return nfe;
    this.throwOnErrors(xml);
    return null;
  }

  /** Erros que não são "não encontrado" viram indisponibilidade (a consulta não pode decidir nada). */
  private throwOnErrors(xml: string): void {
    const { errors } = parseEvents(xml);
    if (errors.length && !errors.every(isNotFound)) {
      throw new FiscalProviderUnavailableError(
        `Consulta na NFS-e de São Paulo falhou: ${errors.map((e) => `${e.code} ${e.message}`).join('; ')}`
      );
    }
  }

  /** Assina a mensagem inteira (XMLDSig na raiz, URI="") e chama o método. */
  private signedCall(
    operation: PaulistanaOperation,
    xml: string,
    root: string,
    pfx: PfxContents,
    certificate: CertificateMaterial
  ): Promise<string> {
    const signed = signEnvelopedSha1(xml, pfx, {
      reference: root,
      placement: 'append',
      byId: false,
    });
    return this.transport.call(this.config.url, operation, signed, certificate);
  }

  private toIssued(
    nfe: Pick<ParsedNFe, 'number' | 'verificationCode' | 'xml'> & Partial<ParsedNFe>,
    tenant: Tenant
  ): IssuedNfse {
    return toIssuedNfse(
      nfe,
      SP_VERIFICATION_URL({
        number: nfe.number,
        verificationCode: nfe.verificationCode,
        ccm: inscricaoPrestador(tenant),
      })
    );
  }
}
