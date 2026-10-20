import { CompanyInfo, CompanyRegistry } from '../../../application/ports/services.js';
import { DomainError } from '../../../domain/shared/domain-error.js';

/** A BrasilAPI fica atrás da Cloudflare, que bloqueia (403) requisições sem User-Agent. */
export const ACAINFE_USER_AGENT = 'acainfe/0.1 (+https://xn--aanfe-yra7b.com)';

/** Dados públicos do CNPJ via BrasilAPI (espelho da base da Receita Federal). */
export class BrasilApiCompanyRegistry implements CompanyRegistry {
  constructor(
    private readonly baseUrl = 'https://brasilapi.com.br/api/cnpj/v1',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 1_000
  ) {}

  private request(cnpj: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/${cnpj}`, {
      headers: { Accept: 'application/json', 'User-Agent': ACAINFE_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  }

  async lookup(cnpj: string): Promise<CompanyInfo | null> {
    let response: Response | undefined;
    // Uma nova tentativa para instabilidade momentânea (rede, 429, 5xx, bloqueio da Cloudflare).
    for (let attempt = 1; attempt <= 2; attempt++) {
      response = await this.request(cnpj).catch(() => undefined);
      if (response && (response.ok || response.status === 404)) break;
      if (attempt === 1) await new Promise((r) => setTimeout(r, this.retryDelayMs));
    }
    if (response?.status === 404) return null;
    if (!response?.ok) {
      throw new DomainError(
        'UNAVAILABLE',
        'Não conseguimos consultar o CNPJ na Receita Federal agora. Tente de novo em alguns minutos.',
        { provider: 'BrasilAPI', status: response?.status }
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (await response.json()) as Record<string, any>;
    const secondary = Array.isArray(d.cnaes_secundarios) ? d.cnaes_secundarios : [];
    return {
      cnpj,
      legalName: String(d.razao_social ?? '').trim(),
      tradeName: d.nome_fantasia ? String(d.nome_fantasia).trim() : undefined,
      cityCode: String(d.codigo_municipio_ibge ?? ''),
      cityName: titleCase(String(d.municipio ?? '')),
      uf: String(d.uf ?? ''),
      simplesNacional: d.opcao_pelo_simples === true,
      mei: d.opcao_pelo_mei === true,
      active: String(d.descricao_situacao_cadastral ?? '').toUpperCase() === 'ATIVA',
      situation: String(d.descricao_situacao_cadastral ?? 'desconhecida'),
      cnaes: [
        ...(d.cnae_fiscal
          ? [
              {
                code: String(d.cnae_fiscal),
                description: String(d.cnae_fiscal_descricao ?? ''),
                primary: true,
              },
            ]
          : []),
        ...secondary
          .filter((c: { codigo?: number }) => c?.codigo)
          .map((c: { codigo: number; descricao?: string }) => ({
            code: String(c.codigo),
            description: String(c.descricao ?? ''),
            primary: false,
          })),
      ],
      address: d.logradouro
        ? {
            street: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '),
            number: String(d.numero || 'S/N'),
            complement: d.complemento || undefined,
            district: String(d.bairro ?? ''),
            zipCode: String(d.cep ?? ''),
          }
        : undefined,
      email: d.email || undefined,
    };
  }
}

const titleCase = (s: string): string =>
  s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
