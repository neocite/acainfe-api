import type { User } from '../../domain/account/user.js';
import {
  ActivationStage,
  activationMessage,
  dueStep,
  isBusinessHour,
  STAGE_LABEL,
} from '../../domain/activation/activation.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import type { Tenant } from '../../domain/tenant/tenant.js';
import {
  InvoiceRepository,
  ProductRepository,
  TenantRepository,
  UserRepository,
} from '../ports/repositories.js';
import { Clock, DocumentLinks, EmailSender, Logger, WhatsappSender } from '../ports/services.js';

export interface ActivationConfig {
  enabled: boolean;
  /** Onde o usuário continua o cadastro (o app). */
  appUrl: string;
  /** Resumo diário de quem está travado: para quem opera o açaínfe. */
  digestEmail?: string;
  digestWhatsapp?: string;
  /** Só olha cadastros recentes (dias). */
  lookbackDays: number;
}

export interface ActivationEntry {
  userId: string;
  name?: string;
  email: string;
  whatsapp?: string;
  tenantId?: string;
  companyName?: string;
  /** Etapa em que parou; WAITLIST = cidade não atendida (sem lembrete: o aviso de liberação já existe). */
  stage: ActivationStage | 'WAITLIST';
  stageLabel: string;
  /** Há quanto tempo está nessa etapa (horas). */
  hoursStuck: number;
  remindersSent: number;
  optedOut: boolean;
  pendingProducts?: string[];
}

const DAY = 86_400_000;
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * Régua de ativação: lembra por WhatsApp e e-mail quem parou no meio do cadastro e manda a quem
 * opera o açaínfe um resumo diário de quem está travado, para o contato pessoal.
 */
export class ActivationService {
  constructor(
    private readonly deps: {
      users: UserRepository;
      tenants: TenantRepository;
      products: ProductRepository;
      invoices: InvoiceRepository;
      email: EmailSender;
      whatsapp: WhatsappSender;
      links: DocumentLinks;
      clock: Clock;
      logger: Logger;
      config: ActivationConfig;
    }
  ) {}

  /** Em que etapa a pessoa parou (null = ativada, já emitiu nota). */
  private async stateOf(user: User): Promise<{
    stage: ActivationStage | 'WAITLIST';
    since: Date;
    tenant?: Tenant;
    pendingProducts?: string[];
  } | null> {
    const tenant = user.tenantIds.length
      ? await this.deps.tenants.findById(user.tenantIds[0])
      : null;
    if (!tenant) return { stage: 'NO_CERTIFICATE', since: user.createdAt };
    if (tenant.status === 'WAITLIST') return { stage: 'WAITLIST', since: tenant.createdAt, tenant };
    const issued = await this.deps.invoices.list(tenant.id, {
      status: ['ISSUED', 'CANCELLED'],
      pageSize: 1,
    });
    if (issued.total > 0) return null;
    const ready = tenant.activatedAt ?? tenant.createdAt;
    const gateway = tenant.integrations.abacatepay;
    if (!gateway) return { stage: 'NO_GATEWAY', since: ready, tenant };
    const connected = gateway.connectedAt ?? ready;
    const pending = await this.deps.products.list(tenant.id, {
      pendingTaxReview: true,
      pageSize: 10,
    });
    if (pending.total > 0) {
      return {
        stage: 'PRODUCTS_PENDING',
        since: connected,
        tenant,
        pendingProducts: pending.items.map((p) => p.name),
      };
    }
    return { stage: 'NO_FIRST_INVOICE', since: connected, tenant };
  }

  private recentUsers(): Promise<User[]> {
    const since = new Date(this.deps.clock.now().getTime() - this.deps.config.lookbackDays * DAY);
    return this.deps.users.listCreatedSince(since);
  }

  /** Job de hora em hora: manda o lembrete devido de cada etapa (só em horário comercial). */
  async run(): Promise<{ reviewed: number; sent: number }> {
    const now = this.deps.clock.now();
    if (!this.deps.config.enabled || !isBusinessHour(now)) return { reviewed: 0, sent: 0 };
    const users = await this.recentUsers();
    let sent = 0;
    for (const user of users) {
      try {
        const state = await this.stateOf(user);
        if (!state || state.stage === 'WAITLIST') continue;
        const step = dueStep(state.stage, state.since, now, user.activation);
        if (!step) continue;
        await this.remind(user, state.stage, state.tenant, state.pendingProducts);
        await this.deps.users.update({
          ...user,
          activation: {
            ...user.activation,
            sent: [...(user.activation?.sent ?? []), { stage: state.stage, step, at: now }],
          },
          updatedAt: now,
        });
        sent++;
      } catch (error) {
        this.deps.logger.error('Falha na régua de ativação', {
          userId: user.id,
          error: String(error),
        });
      }
    }
    return { reviewed: users.length, sent };
  }

  private async remind(
    user: User,
    stage: ActivationStage,
    tenant?: Tenant,
    pendingProducts?: string[]
  ): Promise<void> {
    const { subject, text } = activationMessage({
      stage,
      firstName: user.name?.split(/\s+/)[0],
      appUrl: this.deps.config.appUrl,
      unsubscribeUrl: this.deps.links.unsubscribeUrl?.(user.id),
      pendingProducts,
      companyName: tenant?.tradeName ?? tenant?.legalName,
    });
    const html = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
    await this.deps.email
      .send({ to: user.email, subject, text, html, attachments: [] })
      .catch((e: unknown) =>
        this.deps.logger.warn('Lembrete por e-mail falhou', { userId: user.id, error: String(e) })
      );
    if (user.whatsapp) {
      await this.deps.whatsapp.sendText(user.whatsapp, text).catch((e: unknown) =>
        this.deps.logger.warn('Lembrete por WhatsApp falhou', {
          userId: user.id,
          error: String(e),
        })
      );
    }
  }

  /** Quem está travado e onde (rota de admin e resumo diário). */
  async funnel(): Promise<ActivationEntry[]> {
    const now = this.deps.clock.now();
    const entries: ActivationEntry[] = [];
    for (const user of await this.recentUsers()) {
      const state = await this.stateOf(user);
      if (!state) continue;
      entries.push({
        userId: user.id,
        name: user.name,
        email: user.email,
        whatsapp: user.whatsapp,
        tenantId: state.tenant?.id,
        companyName: state.tenant?.tradeName ?? state.tenant?.legalName,
        stage: state.stage,
        stageLabel:
          state.stage === 'WAITLIST'
            ? 'Lista de espera (cidade não atendida)'
            : STAGE_LABEL[state.stage],
        hoursStuck: Math.floor((now.getTime() - state.since.getTime()) / 3_600_000),
        remindersSent: user.activation?.sent.length ?? 0,
        optedOut: Boolean(user.activation?.optedOutAt),
        pendingProducts: state.pendingProducts,
      });
    }
    return entries.sort((a, b) => b.hoursStuck - a.hoursStuck);
  }

  /** Job diário (9h): resumo de quem está travado para quem opera o açaínfe. */
  async digest(): Promise<{ stuck: number; sent: boolean }> {
    const { enabled, digestEmail, digestWhatsapp } = this.deps.config;
    if (!enabled || (!digestEmail && !digestWhatsapp)) return { stuck: 0, sent: false };
    const entries = await this.funnel();
    if (!entries.length) return { stuck: 0, sent: false };
    const lines = entries.map((e) => {
      const contact = [e.whatsapp ? `+${e.whatsapp}` : undefined, e.email]
        .filter(Boolean)
        .join(' · ');
      const days =
        e.hoursStuck >= 48 ? `${Math.floor(e.hoursStuck / 24)} dias` : `${e.hoursStuck}h`;
      return `• ${e.name ?? '(sem nome)'}${e.companyName ? ` — ${e.companyName}` : ''}\n  ${e.stageLabel} há ${days} · ${e.remindersSent} lembrete(s)${e.optedOut ? ' · pediu para não receber' : ''}\n  ${contact}`;
    });
    const subject = `açaínfe: ${entries.length} cadastro(s) travado(s)`;
    const text = `${subject}\n\n${lines.join('\n\n')}`;
    if (digestEmail) {
      await this.deps.email
        .send({
          to: digestEmail,
          subject,
          text,
          html: `<pre style="font-family:inherit">${escapeHtml(text)}</pre>`,
          attachments: [],
        })
        .catch((e: unknown) =>
          this.deps.logger.warn('Resumo de ativação por e-mail falhou', { error: String(e) })
        );
    }
    if (digestWhatsapp) {
      await this.deps.whatsapp
        .sendText(digestWhatsapp, text)
        .catch((e: unknown) =>
          this.deps.logger.warn('Resumo de ativação por WhatsApp falhou', { error: String(e) })
        );
    }
    return { stuck: entries.length, sent: true };
  }

  /** Link do lembrete: para de mandar mensagens da régua para a pessoa. */
  async unsubscribe(userId: string): Promise<void> {
    const user = await this.deps.users.findById(userId);
    if (!user) throw DomainError.notFound('Usuário', userId);
    if (user.activation?.optedOutAt) return;
    const now = this.deps.clock.now();
    await this.deps.users.update({
      ...user,
      activation: { sent: user.activation?.sent ?? [], optedOutAt: now },
      updatedAt: now,
    });
  }
}
