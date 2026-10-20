import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { NOW } from '../../../test/support/fixtures.js';
import { apiKeyId } from '../../domain/tenant/tenant.js';
import { hashApiKey } from './tenant.service.js';

describe('Chaves do MCP/API: gerar, listar e revogar', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenantId: string;
  let initialKey: string;

  beforeEach(async () => {
    h = buildAppHarness();
    const onboarded = await h.onboard();
    tenantId = onboarded.tenant.id;
    initialKey = onboarded.apiKey;
  });

  it('lista com nome, final e origem, sem o segredo; a mais nova primeiro', async () => {
    const { apiKey, key } = await h.tenants.issueApiKey(tenantId, { label: ' Claude Code ' });
    expect(key).toMatchObject({ label: 'Claude Code', last4: apiKey.slice(-4), legacy: false });
    const items = await h.tenants.listApiKeys(tenantId);
    expect(items.map((k) => k.label)).toEqual(['Claude Code', 'Chave inicial']);
    expect(items[0]).toMatchObject({ createdVia: 'APP', createdAt: NOW });
    expect(JSON.stringify(items)).not.toContain(hashApiKey(apiKey));
  });

  it('revogar uma chave derruba só ela; revogar todas derruba todas', async () => {
    const second = await h.tenants.issueApiKey(tenantId);
    await h.tenants.authenticate(second.apiKey);
    expect(await h.tenants.revokeApiKey(tenantId, second.key.id)).toEqual({
      revoked: second.key.id,
      remaining: 1,
    });
    await expect(h.tenants.authenticate(second.apiKey)).rejects.toThrow(/inválida/);
    expect((await h.tenants.authenticate(initialKey)).id).toBe(tenantId);
    await expect(h.tenants.revokeApiKey(tenantId, 'naoexiste')).rejects.toThrow(/Chave/);

    expect(await h.tenants.revokeAllApiKeys(tenantId)).toEqual({ revoked: 1 });
    await expect(h.tenants.authenticate(initialKey)).rejects.toThrow(/inválida/);
    expect(await h.tenants.listApiKeys(tenantId)).toEqual([]);
  });

  it('chave antiga (sem metadados) aparece como legada e pode ser revogada', async () => {
    const tenant = (await h.repos.tenants.findById(tenantId))!;
    const legacyHash = hashApiKey('acai_chave_antiga');
    await h.repos.tenants.update({ ...tenant, apiKeyHashes: [legacyHash, ...tenant.apiKeyHashes] });
    const items = await h.tenants.listApiKeys(tenantId);
    expect(items.at(-1)).toEqual({ id: apiKeyId(legacyHash), legacy: true });
    // No primeiro uso, a chave antiga ganha o final e o último uso (para o usuário reconhecê-la).
    await h.tenants.authenticate('acai_chave_antiga');
    expect((await h.tenants.listApiKeys(tenantId)).at(-1)).toEqual({
      id: apiKeyId(legacyHash),
      last4: 'tiga',
      lastUsedAt: NOW,
      legacy: true,
      label: undefined,
      createdAt: undefined,
      createdVia: undefined,
    });
    await h.tenants.revokeApiKey(tenantId, apiKeyId(legacyHash));
    await expect(h.tenants.authenticate('acai_chave_antiga')).rejects.toThrow(/inválida/);
  });

  it('registra o último uso (no máximo uma vez por hora)', async () => {
    await h.tenants.authenticate(initialKey);
    const [first] = await h.tenants.listApiKeys(tenantId);
    expect(first.lastUsedAt).toEqual(NOW);
  });

  it('limite de chaves ativas pede para revogar antes de gerar outra', async () => {
    for (let i = 0; i < 9; i++) await h.tenants.issueApiKey(tenantId);
    await expect(h.tenants.issueApiKey(tenantId)).rejects.toThrow(/Limite de 10 chaves/);
  });
});
