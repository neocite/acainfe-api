import { beforeEach, describe, expect, it } from 'vitest';
import { toPaymentView } from '../../adapters/in/http/billing/payment-view.js';
import { buildAppHarness } from '../../../test/support/app-harness.js';

const DAY = 86_400_000;

describe('BillingService (cobrança interna por nota)', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];

  const issuedInvoice = async (externalId: string) => {
    const r = await h.sales.register(tenant, {
      source: 'API',
      externalId,
      items: [{ productExternalId: 'sup', totalCents: 10000 }],
    });
    await h.invoices.issue(r.invoices[0].id);
    return r.invoices[0].id;
  };

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
  });

  it('nota emitida agenda a cobrança; cobrança é idempotente e só para NFS-e emitida', async () => {
    const id = await issuedInvoice('v1');
    expect(h.scheduler.charges.map((c) => c.invoiceId)).toEqual([id]);
    const charge = await h.billing.charge(id);
    expect(charge).toMatchObject({ amountCents: 80, status: 'OPEN', nfseNumber: '1' });
    expect((await h.billing.charge(id))!.id).toBe(charge!.id);
    expect(h.repos.billing.charges.size).toBe(1);
    expect((await h.repos.invoices.findByIdInternal(id))!.billedChargeId).toBe(charge!.id);

    const pending = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'v2',
      items: [{ productExternalId: 'sup', totalCents: 1 }],
    });
    expect(await h.billing.charge(pending.invoices[0].id)).toBeNull();
    h.provider.behaviours = ['REJECT'];
    await h.invoices.issue(pending.invoices[0].id);
    expect(await h.billing.charge(pending.invoices[0].id)).toBeNull(); // rejeitada não é cobrada
  });

  it('varredura do outbox cobra notas emitidas que ficaram sem cobrança', async () => {
    await issuedInvoice('a');
    await issuedInvoice('b');
    expect(await h.billing.sweepUnbilled()).toBe(2);
    expect(await h.billing.sweepUnbilled()).toBe(0);
    expect((await h.billing.summary(tenant.id)).openCents).toBe(160);
  });

  it('respeita preço negociado por empresa', async () => {
    await h.billing.setPrice(tenant.id, 50);
    expect((await h.billing.charge(await issuedInvoice('a')))!.amountCents).toBe(50);
    await h.billing.setPrice(tenant.id, null);
    expect((await h.billing.charge(await issuedInvoice('b')))!.amountCents).toBe(80);
    await expect(h.billing.setPrice(tenant.id, -1)).rejects.toThrow(/inválido/);
    await expect(h.billing.setPrice('nope', 10)).rejects.toThrow(/não encontrad/);
  });

  it('Pix do saldo: mínimo de R$ 1,00, reaproveita o Pix pendente e gera novo se o valor mudar', async () => {
    await expect(h.billing.createPayment(tenant)).rejects.toThrow(/Não há saldo/);
    await h.billing.charge(await issuedInvoice('a'));
    const p1 = await h.billing.createPayment(tenant);
    expect(p1).toMatchObject({ amountCents: 100, status: 'PENDING', pixCopyPaste: '00020126PIX1' });
    expect(h.billingGateway.created[0].metadata).toMatchObject({
      tenantId: tenant.id,
      paymentId: p1.id,
    });
    expect((await h.billing.createPayment(tenant)).id).toBe(p1.id);

    await h.billing.charge(await issuedInvoice('b'));
    const p2 = await h.billing.createPayment(tenant);
    expect(p2.amountCents).toBe(160);
    expect((await h.repos.billing.findPayment(p1.id))!.status).toBe('EXPIRED');
  });

  it('pagamento quita as cobranças, guarda a sobra como crédito e abate as próximas', async () => {
    await h.billing.charge(await issuedInvoice('a'));
    const p = await h.billing.createPayment(tenant);
    await h.billing.confirmPayment(p.providerId!, 100);
    expect(await h.billing.summary(tenant.id)).toMatchObject({
      openCents: 0,
      creditCents: 20,
      amountDueCents: 0,
    });
    expect(h.email.sent.at(-1)!.subject).toMatch(/Pagamento recebido/);
    expect((await h.billing.confirmPayment(p.providerId!, 100))!.status).toBe('PAID'); // idempotente
    expect(await h.billing.confirmPayment('desconhecido')).toBeNull();

    await h.billing.recordManualPayment(tenant.id, 60); // crédito vai a 80
    const viaCredit = await h.billing.charge(await issuedInvoice('b'));
    expect(viaCredit).toMatchObject({ status: 'PAID', settledBy: 'CREDIT' });
    expect((await h.billing.summary(tenant.id)).creditCents).toBe(0);
    await expect(h.billing.recordManualPayment(tenant.id, 0)).rejects.toThrow(/inválido/);
  });

  it('aviso diário com Pix; após 7 dias pausa a emissão (vendas seguem registradas) e retoma ao pagar', async () => {
    const owner = await h.accounts.identify({ externalId: 'u', email: 'dono@x.com' });
    await h.accounts.linkTenant(
      await h.accounts.updateProfile(owner, { whatsapp: '11999990000' }),
      tenant.id
    );
    await h.billing.charge(await issuedInvoice('a'));

    const day1 = await h.billing.daily();
    expect(day1).toEqual({ reviewed: 1, reminded: 1, blocked: 0 });
    const reminder = h.email.sent.at(-1)!;
    expect(reminder.subject).toMatch(/Saldo açaínfe: R\$\s1,00/);
    expect(reminder.text).toMatch(/Pague até/);
    expect(reminder.text).toContain('00020126PIX1');
    expect(h.whatsapp.texts.at(-1)).toMatchObject({
      phone: '5511999990000',
      text: expect.stringContaining('00020126PIX1'),
    });
    expect(h.email.sent.some((m) => m.to === 'dono@x.com')).toBe(true);
    expect((await h.billing.daily()).reminded).toBe(0); // só um aviso por dia

    h.clock.advance(7 * DAY + 1000);
    const day8 = await h.billing.daily();
    expect(day8.blocked).toBe(1);
    expect(await h.billing.isBlocked(tenant.id)).toBe(true);
    expect(
      h.email.sent.some(
        (m) => /pausada/.test(m.subject) && /desacordo com a legislação/.test(m.text)
      )
    ).toBe(true);

    // Venda chega com a emissão pausada: fica na fila com explicação, sem ir à prefeitura.
    const blockedSale = await h.sales.register(tenant, {
      source: 'API',
      externalId: 'b',
      items: [{ productExternalId: 'sup', totalCents: 500 }],
    });
    const blockedId = blockedSale.invoices[0].id;
    const callsBefore = h.provider.calls.length;
    await h.invoices.issue(blockedId);
    expect(h.provider.calls.length).toBe(callsBefore);
    const stuck = (await h.repos.invoices.findByIdInternal(blockedId))!;
    expect(stuck).toMatchObject({ status: 'PENDING', lastErrors: [{ code: 'BILLING_BLOCKED' }] });
    expect((await h.invoices.explain(tenant.id, blockedId)).hints[0]).toMatch(/pay_billing/);

    // Pagou: emissão retomada e notas pendentes reagendadas.
    const payment = await h.billing.createPayment(tenant);
    h.scheduler.issues.length = 0;
    await h.billing.confirmPayment(payment.providerId!, payment.amountCents);
    expect(await h.billing.isBlocked(tenant.id)).toBe(false);
    expect(h.scheduler.issues.map((i) => i.invoiceId)).toContain(blockedId);
    expect(h.email.sent.some((m) => /retomada/.test(m.subject))).toBe(true);
    expect((await h.invoices.issue(blockedId))!.status).toBe('ISSUED');
  });

  it('sem gateway de Pix configurado, o pagamento é só manual', async () => {
    const { BillingService } = await import('./billing.service.js');
    const svc = new BillingService({
      ...(h.billing as unknown as { deps: object }).deps,
      gateway: undefined,
    } as never);
    await h.billing.charge(await issuedInvoice('a'));
    await expect(svc.createPayment(tenant)).rejects.toThrow(/indisponível/);
    expect((await svc.listAccounts()).length).toBeGreaterThanOrEqual(0);
  });

  it('Pix leva o pagador com celular (exigido pela AbacatePay); sem telefone, vai sem pagador', async () => {
    await issuedInvoice('cel1');
    await issuedInvoice('cel2');
    await h.billing.sweepUnbilled();
    await h.repos.tenants.update({ ...tenant, phone: '5511988887777' });
    tenant = (await h.repos.tenants.findById(tenant.id))!;
    await h.billing.createPayment(tenant);
    expect(h.billingGateway.created.at(-1)!.customer).toEqual({
      name: tenant.legalName,
      email: tenant.email,
      taxId: tenant.cnpj,
      cellphone: '(11) 98888-7777',
    });
  });
});

describe('formatCellphone', () => {
  it('formata como nos exemplos da AbacatePay', async () => {
    const { formatCellphone } = await import('./billing.service.js');
    expect(formatCellphone('5511988887777')).toBe('(11) 98888-7777');
    expect(formatCellphone('1140028922')).toBe('(11) 4002-8922');
  });
});

describe('visão do Pix de cobrança', () => {
  it('pendente com prazo vencido aparece como EXPIRED; pago traz o valor efetivo', () => {
    const base = {
      id: 'pay_1',
      tenantId: 't',
      amountCents: 160,
      chargeIds: [],
      provider: 'ABACATEPAY' as const,
      createdAt: new Date('2026-10-26T10:00:00Z'),
      expiresAt: new Date('2026-10-26T12:00:00Z'),
    };
    const now = new Date('2026-10-26T13:00:00Z');
    expect(toPaymentView({ ...base, status: 'PENDING' }, now)).toMatchObject({
      paymentId: 'pay_1',
      status: 'EXPIRED',
      paidAmountCents: undefined,
    });
    expect(
      toPaymentView({ ...base, status: 'PENDING' }, new Date('2026-10-26T11:00:00Z')).status
    ).toBe('PENDING');
    expect(
      toPaymentView({ ...base, status: 'PAID', paidAmountCents: 200, paidAt: now }, now)
    ).toMatchObject({ status: 'PAID', paidAmountCents: 200, currency: 'BRL' });
  });
});
