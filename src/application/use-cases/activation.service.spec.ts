import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { makeInvoice, NOW } from '../../../test/support/fixtures.js';
import { generateTestPfx } from '../../../test/support/test-certificate.js';
import { HmacDocumentLinks } from '../../adapters/out/system.js';
import { activationMessage, dueStep, isBusinessHour } from '../../domain/activation/activation.js';
import { createCoverage } from '../../domain/tenant/coverage.js';
import { ActivationService } from './activation.service.js';

const HOUR = 3_600_000;

describe('régua de ativação: regras', () => {
  const since = new Date('2026-10-18T10:00:00Z');
  const at = (hours: number) => new Date(since.getTime() + hours * HOUR);

  it('cadência por etapa, um passo por vez e sem rajada', () => {
    expect(dueStep('NO_CERTIFICATE', since, at(0.5), undefined)).toBeNull();
    expect(dueStep('NO_CERTIFICATE', since, at(1), undefined)).toBe(1);
    const sent = { sent: [{ stage: 'NO_CERTIFICATE' as const, step: 1, at: at(1) }] };
    expect(dueStep('NO_CERTIFICATE', since, at(23), sent)).toBeNull();
    expect(dueStep('NO_CERTIFICATE', since, at(24), sent)).toBe(2);
    // Servidor parado por dias: manda só o passo mais recente.
    expect(dueStep('NO_CERTIFICATE', since, at(100), undefined)).toBe(3);
    expect(
      dueStep('NO_CERTIFICATE', since, at(200), {
        sent: [{ stage: 'NO_CERTIFICATE', step: 3, at: at(100) }],
      })
    ).toBeNull();
    expect(dueStep('NO_FIRST_INVOICE', since, at(24 * 7), undefined)).toBe(1);
    expect(dueStep('NO_GATEWAY', since, at(100), { optedOutAt: at(1), sent: [] })).toBeNull();
  });

  it('só entre 9h e 20h de Brasília', () => {
    expect(isBusinessHour(new Date('2026-10-18T12:00:00Z'))).toBe(true); // 9h
    expect(isBusinessHour(new Date('2026-10-18T22:59:00Z'))).toBe(true); // 19h59
    expect(isBusinessHour(new Date('2026-10-18T23:00:00Z'))).toBe(false); // 20h
    expect(isBusinessHour(new Date('2026-10-18T11:59:00Z'))).toBe(false); // 8h59
  });

  it('mensagem com o link do app e o descadastro', () => {
    const m = activationMessage({
      stage: 'PRODUCTS_PENDING',
      firstName: 'Ana',
      appUrl: 'https://acainfe.com/',
      unsubscribeUrl: 'https://api.x/unsub',
      pendingProducts: ['Mentoria', 'Curso', 'Workshop', 'Ebook'],
    });
    expect(m.text).toMatch(/^Oi, Ana!/);
    expect(m.text).toContain('Mentoria, Curso, Workshop e outros');
    expect(m.text).toContain('https://acainfe.com');
    expect(m.text).toContain('Não quer mais receber estes lembretes? https://api.x/unsub');
  });
});

describe('ActivationService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let service: ActivationService;
  const links = new HmacDocumentLinks('https://api.acainfe.test', 'segredo-de-teste-123456');
  const cert = () =>
    generateTestPfx({
      notBefore: new Date(NOW.getTime() - 86_400_000),
      notAfter: new Date(NOW.getTime() + 365 * 86_400_000),
    });
  const login = async (externalId: string, email: string) => {
    const user = await h.accounts.identify({ externalId, email, name: 'Ana Souza' });
    return h.accounts.updateProfile(user, { whatsapp: '(11) 98888-7777' });
  };

  beforeEach(async () => {
    h = buildAppHarness();
    await h.repos.coverage.upsert(
      createCoverage({ cityCode: '3548708', simples: true, others: false }, NOW)
    );
    service = new ActivationService({
      users: h.repos.users,
      tenants: h.repos.tenants,
      products: h.repos.products,
      invoices: h.repos.invoices,
      email: h.email,
      whatsapp: h.whatsapp,
      links,
      clock: h.clock,
      logger: h.logger,
      config: {
        enabled: true,
        appUrl: 'https://acainfe.com',
        digestEmail: 'paulo@extractify.com.br',
        digestWhatsapp: '5511945817955',
        lookbackDays: 30,
      },
    });
  });

  it('sem certificado: lembra 1h depois por e-mail e WhatsApp, não repete e segue a cadência', async () => {
    await login('u1', 'ana@x.com'); // cadastrada às 10h (Brasília)
    expect(await service.run()).toMatchObject({ sent: 0 });

    h.clock.advance(HOUR);
    expect(await service.run()).toMatchObject({ sent: 1 });
    const email = h.email.sent.at(-1)!;
    expect(email).toMatchObject({
      to: 'ana@x.com',
      subject: 'Falta só o certificado para emitir sua primeira nota',
    });
    expect(email.text).toContain('/v1/public/activation/unsubscribe?u=');
    expect(h.whatsapp.texts.at(-1)).toMatchObject({ phone: '5511988887777' });
    expect(await service.run()).toMatchObject({ sent: 0 });

    h.clock.advance(23 * HOUR); // 24h depois, 10h da manhã
    expect(await service.run()).toMatchObject({ sent: 1 });
  });

  it('fora do horário comercial não manda; descadastro para a régua', async () => {
    const user = await login('u1', 'ana@x.com');
    h.clock.advance(11 * HOUR); // 21h em Brasília
    expect(await service.run()).toMatchObject({ sent: 0 });
    await service.unsubscribe(user.id);
    h.clock.advance(13 * HOUR); // 10h do dia seguinte
    expect(await service.run()).toMatchObject({ sent: 0 });
    expect((await service.funnel())[0]).toMatchObject({ optedOut: true });
  });

  it('acompanha as etapas: sem AbacatePay → tudo pronto → ativada (sai da régua)', async () => {
    const user = await login('u1', 'ana@x.com');
    const { pfx, password } = cert();
    const { tenant: view } = await h.onboarding.submitCertificate(user, pfx, password);
    let [entry] = await service.funnel();
    expect(entry).toMatchObject({ stage: 'NO_GATEWAY', companyName: expect.any(String) });

    h.clock.advance(24 * HOUR);
    expect(await service.run()).toMatchObject({ sent: 1 });
    expect(h.email.sent.at(-1)!.subject).toMatch(/Conecte o AbacatePay/);

    h.gateway.products = [{ id: 'p1', name: 'Curso', priceCents: 1000, recurring: false }];
    const tenant = (await h.repos.tenants.findById(view.id))!;
    await h.tenants.update(tenant.id, { businessType: 'INFOPRODUCER' });
    await h.onboarding.connectAbacatePay(
      (await h.repos.tenants.findById(view.id))!,
      h.gateway.validKey
    );
    [entry] = await service.funnel();
    expect(entry.stage).toBe('NO_FIRST_INVOICE');

    await h.repos.invoices.createMany([
      makeInvoice({ id: 'inv-x', tenantId: view.id, status: 'ISSUED' }),
    ]);
    expect(await service.funnel()).toEqual([]);
  });

  it('resumo diário para quem opera: quem está travado, onde e o contato', async () => {
    await login('u1', 'ana@x.com');
    h.clock.advance(50 * HOUR);
    expect(await service.digest()).toEqual({ stuck: 1, sent: true });
    const email = h.email.sent.at(-1)!;
    expect(email).toMatchObject({
      to: 'paulo@extractify.com.br',
      subject: 'açaínfe: 1 cadastro(s) travado(s)',
    });
    expect(email.text).toContain('Ana Souza');
    expect(email.text).toContain('Conta criada, sem certificado há 2 dias');
    expect(email.text).toContain('+5511988887777');
    expect(h.whatsapp.texts.at(-1)!.phone).toBe('5511945817955');
  });

  it('link de descadastro é assinado por usuário', () => {
    const url = new URL(links.unsubscribeUrl('user-1')!);
    const sig = url.searchParams.get('sig')!;
    expect(links.verifyUnsubscribe('user-1', sig)).toBe(true);
    expect(links.verifyUnsubscribe('user-2', sig)).toBe(false);
  });
});
