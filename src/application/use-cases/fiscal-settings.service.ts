import { productWarnings } from '../../domain/product/product.js';
import { IbsCbsProfile } from '../../domain/product/tax-profile.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { formatBps } from '../../domain/shared/money.js';
import {
  companyFiscalProfile,
  companyIssRateBps,
  simplesRateBps,
  Tenant,
} from '../../domain/tenant/tenant.js';
import { ProductRepository } from '../ports/repositories.js';
import { Clock, EmailSender, Logger, WhatsappSender } from '../ports/services.js';
import { CompanyStatus, EmissionView, OnboardingService } from './onboarding.service.js';

const REGIME_LABEL: Record<Tenant['taxRegime'], string> = {
  MEI: 'MEI',
  SIMPLES_NACIONAL: 'Simples Nacional (ME/EPP)',
  SIMPLES_NACIONAL_EXCESSO: 'Simples Nacional (excesso de sublimite)',
  LUCRO_PRESUMIDO: 'Lucro Presumido',
  LUCRO_REAL: 'Lucro Real',
};

const RETENTION_LABEL = {
  NONE: 'Não retido',
  TOMADOR: 'Retido pelo tomador',
  INTERMEDIARIO: 'Retido pelo intermediário',
};

interface TaxView {
  nationalServiceCode: string;
  localServiceCode?: string;
  nbsCode?: string;
  issRateBps?: number;
  issRetention: string;
  ibsCbs?: IbsCbsProfile;
}

/** Ficha fiscal da empresa: tudo o que define as notas, para conferir com o contador. */
export interface FiscalSettings {
  company: {
    cnpj: string;
    legalName: string;
    tradeName?: string;
    municipalRegistration?: string;
    city: { code: string; name?: string; uf?: string };
    taxRegime: Tenant['taxRegime'];
    taxRegimeLabel: string;
    /** Alíquota efetiva do Simples (informada ou a estimativa usada). */
    simplesNacionalTaxRateBps?: number;
    simplesRateIsEstimate: boolean;
    cnaes: Tenant['cnaes'];
  };
  emission: EmissionView & { series: string; nextNumber: number };
  taxDefaults?: TaxView & {
    businessType: string;
    profileLabel: string;
    /** Perfil validado por contador (confirma os produtos sozinho) ou só sugestão. */
    validated: boolean;
    /** Confirma produtos sozinho (perfil validado e coerente com os CNAEs). */
    autoConfirm: boolean;
    /** Aviso quando o perfil validado não bate com os CNAEs da empresa. */
    warning?: string;
  };
  /** ISS da empresa: informado, estimado pelo Simples ou não definido. */
  issRate: { bps?: number; source: 'INFORMED' | 'SIMPLES_ESTIMATE' | 'NOT_SET' };
  approximateTaxes?: { rateBps?: number; descriptionTemplate?: string; source?: string };
  certificate: CompanyStatus['certificate'];
  accountant?: {
    name?: string;
    email?: string;
    whatsapp?: string;
    monthlyReport: boolean;
    dayOfMonth: number;
  };
  products: (TaxView & { id: string; name: string; status: string; warnings: string[] })[];
  readiness: CompanyStatus['readiness'];
  generatedAt: Date;
  /** O mesmo conteúdo em texto (para copiar ou enviar ao contador). */
  text: string;
}

const bps = (v?: number) => (v === undefined ? '—' : `${formatBps(v)}%`);

export class FiscalSettingsService {
  constructor(
    private readonly deps: {
      onboarding: OnboardingService;
      products: ProductRepository;
      email: EmailSender;
      whatsapp: WhatsappSender;
      clock: Clock;
      logger: Logger;
    }
  ) {}

  async get(tenant: Tenant): Promise<FiscalSettings> {
    const status = await this.deps.onboarding.status(tenant);
    const profile = companyFiscalProfile(tenant);
    const issBps = companyIssRateBps(tenant);
    const isSimples =
      tenant.taxRegime === 'SIMPLES_NACIONAL' || tenant.taxRegime === 'SIMPLES_NACIONAL_EXCESSO';
    const products = (await this.deps.products.list(tenant.id, { pageSize: 100 })).items;
    const settings: Omit<FiscalSettings, 'text'> = {
      company: {
        cnpj: tenant.cnpj,
        legalName: tenant.legalName,
        tradeName: tenant.tradeName,
        municipalRegistration: tenant.municipalRegistration,
        city: { code: tenant.cityCode, name: tenant.cityName, uf: tenant.uf },
        taxRegime: tenant.taxRegime,
        taxRegimeLabel: REGIME_LABEL[tenant.taxRegime],
        simplesNacionalTaxRateBps: isSimples ? simplesRateBps(tenant) : undefined,
        simplesRateIsEstimate: isSimples && tenant.simplesNacionalTaxRateBps === undefined,
        cnaes: tenant.cnaes,
      },
      emission: {
        ...status.emission,
        series: tenant.dpsSeries,
        nextNumber: tenant.lastDpsNumber + 1,
      },
      taxDefaults:
        profile && tenant.businessType
          ? {
              businessType: tenant.businessType,
              profileLabel: profile.definition.label,
              validated: profile.definition.validated,
              autoConfirm: profile.autoConfirm,
              warning: profile.warning,
              nationalServiceCode: profile.taxProfile.nationalServiceCode,
              localServiceCode: profile.taxProfile.localServiceCode,
              nbsCode: profile.taxProfile.nbsCode,
              issRateBps: profile.taxProfile.issRateBps,
              issRetention: RETENTION_LABEL[profile.taxProfile.issRetention],
              ibsCbs: profile.taxProfile.ibsCbs,
            }
          : undefined,
      issRate: {
        bps: issBps,
        source:
          tenant.issRateBps !== undefined
            ? 'INFORMED'
            : issBps !== undefined
              ? 'SIMPLES_ESTIMATE'
              : 'NOT_SET',
      },
      approximateTaxes: tenant.approximateTaxes && {
        rateBps: tenant.approximateTaxes.rateBps,
        descriptionTemplate: tenant.approximateTaxes.descriptionTemplate,
        source: tenant.approximateTaxes.source,
      },
      certificate: status.certificate,
      accountant: tenant.accountant && { ...tenant.accountant },
      products: products.map((p) => {
        const t = p.taxProfile ?? p.suggestedTaxProfile;
        return {
          id: p.id,
          name: p.name,
          status: !p.active
            ? 'Inativo'
            : p.taxStatus === 'CONFIRMED'
              ? 'Tributação confirmada'
              : 'Aguardando confirmação',
          nationalServiceCode: t?.nationalServiceCode ?? '—',
          localServiceCode: t?.localServiceCode,
          nbsCode: t?.nbsCode,
          issRateBps: t?.issRateBps,
          issRetention: t ? RETENTION_LABEL[t.issRetention] : '—',
          ibsCbs: t?.ibsCbs,
          warnings: productWarnings(p),
        };
      }),
      readiness: status.readiness,
      generatedAt: this.deps.clock.now(),
    };
    return { ...settings, text: fiscalSettingsText(settings) };
  }

  /** Envia a ficha ao contador cadastrado (e-mail e/ou WhatsApp). */
  async sendToAccountant(tenant: Tenant): Promise<{ email?: string; whatsapp?: string }> {
    const accountant = tenant.accountant;
    if (!accountant?.email && !accountant?.whatsapp) {
      throw DomainError.validation(
        'Cadastre o e-mail ou o WhatsApp do contador antes de enviar a ficha fiscal'
      );
    }
    const settings = await this.get(tenant);
    const intro = `Olá${accountant.name ? `, ${accountant.name}` : ''}! Segue a configuração fiscal usada pelo açaínfe para emitir as NFS-e da ${tenant.legalName}. Pode conferir e nos avisar se algo precisar de ajuste?`;
    const sent: { email?: string; whatsapp?: string } = {};
    if (accountant.email) {
      await this.deps.email.send({
        to: accountant.email,
        subject: `Configuração fiscal da ${tenant.legalName} no açaínfe`,
        text: `${intro}\n\n${settings.text}`,
        html: `<p>${intro}</p><pre style="font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(settings.text)}</pre>`,
        attachments: [],
      });
      sent.email = accountant.email;
    }
    if (accountant.whatsapp) {
      await this.deps.whatsapp
        .sendText(accountant.whatsapp, `${intro}\n\n${settings.text}`)
        .then(() => (sent.whatsapp = accountant.whatsapp))
        .catch((error: unknown) =>
          this.deps.logger.warn('Falha ao enviar ficha fiscal por WhatsApp', {
            tenantId: tenant.id,
            error: String(error),
          })
        );
    }
    return sent;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ibsCbsText = (g?: IbsCbsProfile) =>
  g
    ? `CST ${g.cst} · cClassTrib ${g.cClassTrib} · indicador da operação ${g.operationIndicator}`
    : '—';

/** Ficha fiscal em texto simples (para copiar ou enviar ao contador). */
export function fiscalSettingsText(s: Omit<FiscalSettings, 'text'>): string {
  const c = s.company;
  const lines: string[] = [
    `FICHA FISCAL — ${c.legalName}`,
    '',
    'EMPRESA',
    `CNPJ: ${c.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}`,
    `Inscrição municipal (CCM): ${c.municipalRegistration ?? 'não informada'}`,
    `Município: ${c.city.name ?? c.city.code}${c.city.uf ? `/${c.city.uf}` : ''} (IBGE ${c.city.code})`,
    `Regime tributário: ${c.taxRegimeLabel}`,
    ...(c.simplesNacionalTaxRateBps !== undefined
      ? [
          `Alíquota efetiva do Simples: ${bps(c.simplesNacionalTaxRateBps)}${c.simplesRateIsEstimate ? ' (estimativa — informe a do DAS)' : ''}`,
        ]
      : []),
    `CNAEs: ${c.cnaes.map((x) => `${x.code}${x.primary ? ' (principal)' : ''}`).join(', ') || '—'}`,
    '',
    'EMISSÃO',
    `Sistema: ${s.emission.systemLabel}`,
    `Ambiente: ${s.emission.environment === 'PRODUCTION' ? 'Produção' : 'Homologação (sem valor fiscal)'}`,
    `Série do RPS/DPS: ${s.emission.series} · próximo número: ${s.emission.nextNumber}`,
    '',
    'TRIBUTAÇÃO PADRÃO DOS PRODUTOS',
  ];
  const t = s.taxDefaults;
  if (t) {
    lines.push(
      `Perfil: ${t.profileLabel}${t.validated ? ' (validado)' : ' (sugestão, confirmar com o contador)'}`,
      `Código de tributação nacional: ${t.nationalServiceCode}`,
      `Código de tributação municipal: ${t.localServiceCode ?? '—'}`,
      `NBS: ${t.nbsCode ?? '—'}`,
      `ISS: ${bps(s.issRate.bps)} (${s.issRate.source === 'INFORMED' ? 'informado' : s.issRate.source === 'SIMPLES_ESTIMATE' ? 'parcela do ISS no Simples, Anexo III' : 'não definido'}) · ${t.issRetention}`,
      `IBS/CBS: ${ibsCbsText(t.ibsCbs)}`
    );
  } else {
    lines.push('Não definida (responda "O que você vende?" no app)');
  }
  const a = s.approximateTaxes;
  lines.push(
    '',
    'TRIBUTOS APROXIMADOS (Lei 12.741)',
    a?.rateBps !== undefined
      ? `${bps(a.rateBps)} · texto na nota: "${a.descriptionTemplate ?? '—'}"`
      : 'Não configurado'
  );
  lines.push(
    '',
    'CERTIFICADO A1',
    s.certificate.present
      ? `Válido até ${s.certificate.expiresAt?.toISOString().slice(0, 10).split('-').reverse().join('/') ?? '—'}${s.certificate.expired ? ' (VENCIDO)' : ''}`
      : 'Não enviado'
  );
  if (s.products.length) {
    lines.push('', 'PRODUTOS');
    for (const p of s.products) {
      lines.push(
        `- ${p.name}: ${p.nationalServiceCode}${p.localServiceCode ? ` / ${p.localServiceCode}` : ''} · NBS ${p.nbsCode ?? '—'} · ${p.status}`
      );
    }
  }
  if (s.readiness.missing.length) {
    lines.push('', 'PENDÊNCIAS', ...s.readiness.missing.map((m) => `- ${m.message}`));
  }
  lines.push(
    '',
    `Gerado pelo açaínfe em ${s.generatedAt.toISOString().slice(0, 10).split('-').reverse().join('/')}`
  );
  return lines.join('\n');
}
