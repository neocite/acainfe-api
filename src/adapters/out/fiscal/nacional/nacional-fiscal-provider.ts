import CircuitBreaker from 'opossum';
import {
  CertificateMaterial,
  FiscalProvider,
  FiscalProviderUnavailableError,
  IssueOutcome,
  MunicipalParamsGateway,
  MunicipalServiceParams,
} from '../../../../application/ports/fiscal-provider.js';
import { Clock, Logger } from '../../../../application/ports/services.js';
import { FiscalError, Invoice, IssuedNfse } from '../../../../domain/invoice/invoice.js';
import { DomainError } from '../../../../domain/shared/domain-error.js';
import { Tenant } from '../../../../domain/tenant/tenant.js';
import { openPfx } from '../../crypto/pfx.js';
import { buildCancellationXml, buildDpsXml } from './dps-builder.js';
import { HttpResponse, MtlsHttpClient, TransportError } from './mtls-http.js';
import { gunzipBase64, gzipBase64, parseNfseXml } from './nfse-xml-parser.js';
import { signXml } from './xml-signer.js';

export interface NacionalEndpoints {
  sefinProduction: string;
  sefinHomologation: string;
  adnProduction: string;
  adnHomologation: string;
}

export const DEFAULT_ENDPOINTS: NacionalEndpoints = {
  sefinProduction: 'https://sefin.nfse.gov.br/SefinNacional',
  sefinHomologation: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
  adnProduction: 'https://adn.nfse.gov.br',
  adnHomologation: 'https://adn.producaorestrita.nfse.gov.br',
};

/** Normaliza as várias formas de erro devolvidas pela Sefin (erros|erro, array|objeto, Pascal|camelCase). */
export function parseSefinErrors(body: unknown): FiscalError[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const raw = b.erros ?? b.Erros ?? b.erro ?? b.Erro ?? (b.codigo || b.Codigo ? b : undefined);
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((e) => {
    const x = (e ?? {}) as Record<string, unknown>;
    return {
      code: String(x.Codigo ?? x.codigo ?? 'SEFIN'),
      message: String(
        x.Descricao ?? x.descricao ?? x.Mensagem ?? x.mensagem ?? 'Erro não detalhado'
      ),
      complement:
        (x.Complemento ?? x.complemento) ? String(x.Complemento ?? x.complemento) : undefined,
    };
  });
}

const DUPLICATE_RE = /dps.*(j[áa]|existente|duplicad)|j[áa] (existe|foi).*dps|duplicidade/i;
const isUnavailableStatus = (status: number): boolean =>
  status === 0 || status === 408 || status === 429 || status >= 500;

class UnavailableResponse extends Error {}

export class NacionalFiscalProvider implements FiscalProvider, MunicipalParamsGateway {
  readonly name = 'NACIONAL';
  private readonly breaker: CircuitBreaker<[() => Promise<HttpResponse>], HttpResponse>;

  constructor(
    private readonly deps: {
      http: MtlsHttpClient;
      clock: Clock;
      logger: Logger;
      appVersion: string;
      endpoints?: NacionalEndpoints;
      breakerOptions?: CircuitBreaker.Options;
    }
  ) {
    // Abre o circuito quando a Sefin fica indisponível; enquanto aberto, falha rápido e as notas
    // vão direto para RETRYING sem martelar o serviço.
    this.breaker = new CircuitBreaker(async (fn: () => Promise<HttpResponse>) => fn(), {
      timeout: false,
      errorThresholdPercentage: 50,
      volumeThreshold: 5,
      resetTimeout: 60_000,
      ...deps.breakerOptions,
    });
    this.breaker.on('open', () => this.deps.logger.warn('Circuit breaker da Sefin ABERTO'));
    this.breaker.on('close', () => this.deps.logger.info('Circuit breaker da Sefin fechado'));
  }

  private get endpoints(): NacionalEndpoints {
    return this.deps.endpoints ?? DEFAULT_ENDPOINTS;
  }

  private sefin(tenant: Tenant): string {
    return tenant.environment === 'PRODUCTION'
      ? this.endpoints.sefinProduction
      : this.endpoints.sefinHomologation;
  }

  private adn(tenant: Tenant): string {
    return tenant.environment === 'PRODUCTION'
      ? this.endpoints.adnProduction
      : this.endpoints.adnHomologation;
  }

  /** Executa a chamada via circuit breaker; só indisponibilidade conta como falha. */
  private async call(
    method: 'GET' | 'POST' | 'HEAD',
    url: string,
    certificate: CertificateMaterial,
    body?: unknown
  ): Promise<HttpResponse> {
    try {
      return await this.breaker.fire(async () => {
        const response = await this.deps.http.request(method, url, certificate, body);
        if (isUnavailableStatus(response.status)) {
          throw new UnavailableResponse(`Sefin respondeu HTTP ${response.status}`);
        }
        return response;
      });
    } catch (error) {
      if (error instanceof UnavailableResponse || error instanceof TransportError) {
        throw new FiscalProviderUnavailableError(error.message, error);
      }
      if (this.breaker.opened) {
        throw new FiscalProviderUnavailableError(
          'Sefin indisponível (circuit breaker aberto)',
          error
        );
      }
      throw error;
    }
  }

  async issue(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssueOutcome> {
    let signed: string;
    try {
      const xml = buildDpsXml(invoice, tenant, {
        appVersion: this.deps.appVersion,
        now: this.deps.clock.now(),
      });
      signed = signXml(xml, 'infDPS', openPfx(certificate.pfx, certificate.password));
    } catch (error) {
      if (error instanceof DomainError) {
        return {
          kind: 'REJECTED',
          errors: [{ code: `LOCAL_${error.code}`, message: error.message }],
        };
      }
      throw error;
    }

    const response = await this.call('POST', `${this.sefin(tenant)}/nfse`, certificate, {
      dpsXmlGZipB64: gzipBase64(signed),
    });
    const body = (response.body ?? {}) as Record<string, unknown>;
    if (typeof body.chaveAcesso === 'string') {
      const nfse = body.nfseXmlGZipB64
        ? parseNfseXml(gunzipBase64(String(body.nfseXmlGZipB64)), body.chaveAcesso)
        : await this.fetchByAccessKey(tenant, certificate, body.chaveAcesso);
      if (!nfse) throw new FiscalProviderUnavailableError('NFS-e autorizada mas XML indisponível');
      return { kind: 'ISSUED', nfse };
    }
    const errors = parseSefinErrors(body);
    if (!errors.length) {
      errors.push({
        code: `HTTP_${response.status}`,
        message: response.raw.slice(0, 500) || 'Resposta vazia da Sefin',
      });
    }
    if (errors.some((e) => DUPLICATE_RE.test(`${e.message} ${e.complement ?? ''}`))) {
      return { kind: 'DUPLICATE', errors };
    }
    return { kind: 'REJECTED', errors };
  }

  async findByDpsId(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial
  ): Promise<IssuedNfse | null> {
    const response = await this.call(
      'GET',
      `${this.sefin(tenant)}/dps/${invoice.dps.id}`,
      certificate
    );
    if (response.status === 404) return null;
    const key = (response.body as Record<string, unknown> | undefined)?.chaveAcesso;
    if (response.status >= 300 || typeof key !== 'string') return null;
    return this.fetchByAccessKey(tenant, certificate, key);
  }

  private async fetchByAccessKey(
    tenant: Tenant,
    certificate: CertificateMaterial,
    key: string
  ): Promise<IssuedNfse | null> {
    const response = await this.call('GET', `${this.sefin(tenant)}/nfse/${key}`, certificate);
    const b64 = (response.body as Record<string, unknown> | undefined)?.nfseXmlGZipB64;
    if (response.status >= 300 || typeof b64 !== 'string') return null;
    return parseNfseXml(gunzipBase64(b64), key);
  }

  async cancel(
    invoice: Invoice,
    tenant: Tenant,
    certificate: CertificateMaterial,
    reason: { code: string; description: string }
  ): Promise<{ ok: true } | { ok: false; errors: FiscalError[] }> {
    if (!invoice.nfse)
      return { ok: false, errors: [{ code: 'LOCAL', message: 'Nota sem chave de acesso' }] };
    const key = invoice.nfse.accessKey;
    const xml = buildCancellationXml(key, tenant, reason, {
      appVersion: this.deps.appVersion,
      now: this.deps.clock.now(),
    });
    const signed = signXml(xml, 'infPedReg', openPfx(certificate.pfx, certificate.password));
    const response = await this.call(
      'POST',
      `${this.sefin(tenant)}/nfse/${key}/eventos`,
      certificate,
      {
        pedidoRegistroEventoXmlGZipB64: gzipBase64(signed),
      }
    );
    if (response.status < 300) return { ok: true };
    const errors = parseSefinErrors(response.body);
    return {
      ok: false,
      errors: errors.length
        ? errors
        : [{ code: `HTTP_${response.status}`, message: response.raw.slice(0, 500) }],
    };
  }

  /**
   * Alíquota do código de serviço no município (ADN parametrização).
   * `codServ` no formato 01.07.01.000 e competência AAAA-MM-DD (formato a confirmar em homologação).
   */
  async get(
    cityCode: string,
    nationalServiceCode: string,
    competence: Date,
    context: { tenant: Tenant; certificate: CertificateMaterial }
  ): Promise<MunicipalServiceParams | null> {
    const c = nationalServiceCode;
    const codServ = `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4, 6)}.000`;
    const comp = competence.toISOString().slice(0, 10);
    const response = await this.call(
      'GET',
      `${this.adn(context.tenant)}/parametrizacao/${cityCode}/${codServ}/${comp}/aliquota`,
      context.certificate
    );
    if (response.status === 404 || response.status >= 300) return null;
    const body = (response.body ?? {}) as { aliquotas?: Record<string, { Aliq?: number }[]> };
    const entries = body.aliquotas?.[codServ] ?? Object.values(body.aliquotas ?? {})[0] ?? [];
    // A ADN devolve decimal (2.0 = 2%); convertemos na borda para pontos-base inteiros.
    const aliq = entries[0]?.Aliq;
    return {
      cityCode,
      nationalServiceCode,
      issRateBps: typeof aliq === 'number' ? Math.round(aliq * 100) : undefined,
      raw: response.body,
    };
  }
}
