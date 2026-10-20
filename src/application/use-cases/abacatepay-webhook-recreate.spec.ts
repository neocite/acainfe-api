import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { Tenant } from '../../domain/tenant/tenant.js';

describe('Recriar o webhook do AbacatePay (URL da API mudou)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Tenant;
  const reload = async () => (tenant = (await h.repos.tenants.findById(tenant.id))!);

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
  });

  it('conexão registra a URL do webhook; o status mostra se está atualizada', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    const status = await h.onboarding.status(tenant);
    expect(status.abacatepay).toMatchObject({
      connected: true,
      webhookEndpoint: `https://api.acainfe.test/v1/webhooks/abacatepay/${tenant.id}`,
      webhookUpToDate: true,
    });
  });

  it('webhook antigo (outra URL): recria com a key salva e um segredo novo', async () => {
    await h.onboarding.connectAbacatePay(tenant, h.gateway.validKey);
    await reload();
    const old = tenant.integrations.abacatepay!;
    await h.repos.tenants.update({
      ...tenant,
      integrations: {
        abacatepay: {
          ...old,
          webhookEndpoint: 'https://flowing-rabbit.ngrok-free.app/v1/webhooks/abacatepay/x',
        },
      },
    });
    await reload();
    expect((await h.onboarding.status(tenant)).abacatepay.webhookUpToDate).toBe(false);

    const r = await h.onboarding.recreateAbacatePayWebhook(tenant);
    expect(r).toMatchObject({
      webhookId: 'webh_2',
      endpoint: `https://api.acainfe.test/v1/webhooks/abacatepay/${tenant.id}`,
      previous: { webhookId: 'webh_1' },
    });
    expect(h.gateway.webhooks).toHaveLength(2);
    expect(h.gateway.webhooks[1]).toMatchObject({
      apiKey: h.gateway.validKey,
      endpoint: r.endpoint,
    });
    await reload();
    expect(tenant.integrations.abacatepay!.webhookSecret).not.toBe(old.webhookSecret);
    expect(tenant.integrations.abacatepay!.webhookSecret).toBe(h.gateway.webhooks[1].secret);
    expect((await h.onboarding.status(tenant)).abacatepay.webhookUpToDate).toBe(true);
  });

  it('sem key salva, pede a key; key informada fica salva', async () => {
    await expect(h.onboarding.recreateAbacatePayWebhook(tenant)).rejects.toThrow(/WEBHOOK:CREATE/);
    await h.onboarding.recreateAbacatePayWebhook(tenant, h.gateway.validKey);
    await reload();
    expect(tenant.integrations.abacatepay!.encryptedApiKey).toBeDefined();
  });
});
