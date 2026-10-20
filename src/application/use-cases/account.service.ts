import { createUser, updateUserProfile, User } from '../../domain/account/user.js';
import { DomainError } from '../../domain/shared/domain-error.js';
import { Tenant } from '../../domain/tenant/tenant.js';
import { TenantRepository, UserRepository } from '../ports/repositories.js';
import { Clock, IdGenerator } from '../ports/services.js';

export interface Identity {
  /** Id estável do usuário no provedor de login (Replit Auth). */
  externalId: string;
  email: string;
  name?: string;
}

/** Usuários do app: identidade vem do provedor de login, confiada via app key do backend do front. */
export class AccountService {
  constructor(
    private readonly deps: {
      users: UserRepository;
      tenants: TenantRepository;
      clock: Clock;
      ids: IdGenerator;
    }
  ) {}

  /** Primeiro acesso cria o usuário; depois só atualiza o e-mail se mudar no provedor. */
  async identify(identity: Identity): Promise<User> {
    const existing = await this.deps.users.findByExternalId(identity.externalId);
    if (existing) {
      const email = identity.email.trim().toLowerCase();
      if (existing.email === email) return existing;
      const updated = { ...existing, email, updatedAt: this.deps.clock.now() };
      await this.deps.users.update(updated);
      return updated;
    }
    const user = createUser(this.deps.ids.next(), identity, this.deps.clock.now());
    await this.deps.users.create(user);
    return user;
  }

  async updateProfile(user: User, patch: { name?: string; whatsapp?: string }): Promise<User> {
    const updated = updateUserProfile(user, patch, this.deps.clock.now());
    await this.deps.users.update(updated);
    return updated;
  }

  async linkTenant(user: User, tenantId: string): Promise<User> {
    if (user.tenantIds.includes(tenantId)) return user;
    const updated = {
      ...user,
      tenantIds: [...user.tenantIds, tenantId],
      updatedAt: this.deps.clock.now(),
    };
    await this.deps.users.update(updated);
    return updated;
  }

  /** Garante que o usuário administra a empresa. */
  async ownedTenant(user: User, tenantId: string): Promise<Tenant> {
    const tenant = user.tenantIds.includes(tenantId)
      ? await this.deps.tenants.findById(tenantId)
      : null;
    if (!tenant || !tenant.ownerUserIds.includes(user.id))
      throw DomainError.notFound('Empresa', tenantId);
    return tenant;
  }

  async tenantsOf(user: User): Promise<Tenant[]> {
    const tenants = await Promise.all(user.tenantIds.map((id) => this.deps.tenants.findById(id)));
    return tenants.filter((t): t is Tenant => Boolean(t));
  }
}
