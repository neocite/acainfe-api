import { beforeEach, describe, expect, it } from 'vitest';
import { buildAppHarness } from '../../../test/support/app-harness.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import { Invoice } from '../../domain/invoice/invoice.js';

describe('InvoiceService', () => {
  let h: ReturnType<typeof buildAppHarness>;
  let tenant: Awaited<ReturnType<typeof h.onboard>>['tenant'];
  let invoice: Invoice;

  async function newSale(externalId = 'p1', customer = { email: 'c@x.com', phone: '11999998888' }) {
    const r = await h.sales.register(tenant, {
      source: 'API',
      externalId,
      customer,
      items: [{ productExternalId: 'sup', totalCents: 15000 }],
    });
    return r.invoices[0];
  }
  const reload = async (id: string) => (await h.repos.invoices.findByIdInternal(id))!;

  beforeEach(async () => {
    h = buildAppHarness();
    tenant = (await h.onboard()).tenant;
    await h.products.create(tenant, {
      name: 'Suporte',
      externalId: 'sup',
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    });
    invoice = await newSale();
  });

  describe('issue (job)', () => {
    it('emite e agenda entregas por e-mail e WhatsApp', async () => {
      const result = await h.invoices.issue(invoice.id);
      expect(result!.status).toBe('ISSUED');
      expect((await reload(invoice.id)).nfse!.number).toBe('1');
      expect(h.scheduler.deliveries.map((d) => d.channel)).toEqual(['EMAIL', 'WHATSAPP']);
    });

    it('prefeitura fora do ar → RETRYING e reagenda para nextAttemptAt', async () => {
      h.provider.behaviours = ['DOWN'];
      const result = await h.invoices.issue(invoice.id);
      expect(result!.status).toBe('RETRYING');
      const scheduled = h.scheduler.issues.at(-1)!;
      expect(scheduled.at).toEqual(result!.nextAttemptAt);
    });

    it('não processa antes do horário agendado e é idempotente para notas finalizadas', async () => {
      h.provider.behaviours = ['DOWN'];
      await h.invoices.issue(invoice.id);
      expect((await h.invoices.issue(invoice.id))!.status).toBe('RETRYING');
      expect(h.provider.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);

      h.clock.advance(60_000);
      expect((await h.invoices.issue(invoice.id))!.status).toBe('ISSUED');
      expect((await h.invoices.issue(invoice.id))!.status).toBe('ISSUED');
      expect(h.provider.calls.filter((c) => c.startsWith('issue'))).toHaveLength(2);
    });

    it('consulta o DPS antes de reenviar após uma tentativa que chegou à prefeitura', async () => {
      h.provider.behaviours = ['DOWN'];
      await h.invoices.issue(invoice.id);
      h.clock.advance(60_000);
      h.provider.existing = sampleNfse('77');
      const result = await h.invoices.issue(invoice.id);
      expect(result!.nfse!.number).toBe('77');
      expect(h.provider.calls).toEqual([`issue:${invoice.id}`, `find:${invoice.id}`]);
    });

    it('rejeição de negócio vira REJECTED com dicas', async () => {
      h.provider.behaviours = ['REJECT'];
      expect((await h.invoices.issue(invoice.id))!.status).toBe('REJECTED');
      const explained = await h.invoices.explain(tenant.id, invoice.id);
      expect(explained.errors[0].code).toBe('E0625');
      expect(explained.hints.join(' ')).toMatch(/issRateBps/);
    });

    it('DPS duplicado: recupera a nota existente ou retenta', async () => {
      h.provider.behaviours = ['DUPLICATE'];
      h.provider.existing = sampleNfse('9');
      expect((await h.invoices.issue(invoice.id))!.nfse!.number).toBe('9');

      const other = await newSale('p2');
      h.provider.behaviours = ['DUPLICATE'];
      h.provider.existing = null;
      expect((await h.invoices.issue(other.id))!.status).toBe('RETRYING');
    });

    it('erro inesperado é tratado como transitório e logado', async () => {
      h.provider.behaviours = ['CRASH'];
      expect((await h.invoices.issue(invoice.id))!.status).toBe('RETRYING');
      expect(h.logger.entries.some((e) => e.level === 'error')).toBe(true);
    });

    it('sem certificado → REJECTED com orientação', async () => {
      h.repos.certificates.items.length = 0;
      const result = await h.invoices.issue(invoice.id);
      expect(result!.status).toBe('REJECTED');
      expect(result!.lastErrors![0].code).toBe('CERTIFICATE_MISSING');
      expect((await h.invoices.explain(tenant.id, invoice.id)).hints[0]).toMatch(/certificado/i);
    });

    it('outro worker já pegou a nota → não processa', async () => {
      const current = (await reload(invoice.id))!;
      await h.repos.invoices.update({ ...current, status: 'PROCESSING' });
      expect(await h.invoices.issue(invoice.id)).toMatchObject({ status: 'PROCESSING' });
      expect(h.provider.calls).toHaveLength(0);
    });
  });

  describe('deliver (job)', () => {
    beforeEach(async () => {
      await h.invoices.issue(invoice.id);
    });

    it('envia e-mail com PDF e WhatsApp com link assinado', async () => {
      await h.invoices.deliver(invoice.id, 'EMAIL');
      await h.invoices.deliver(invoice.id, 'WHATSAPP');
      expect(h.email.sent[0]).toMatchObject({
        to: 'c@x.com',
        attachments: [{ filename: 'NFSe-1.pdf' }],
      });
      expect(h.whatsapp.sent[0]).toMatchObject({
        phone: '5511999998888',
        fileUrl: `https://acainfe.test/pdf/${invoice.id}`,
      });
      const after = await reload(invoice.id);
      expect(after.deliveries.every((d) => d.status === 'SENT')).toBe(true);

      await h.invoices.deliver(invoice.id, 'EMAIL');
      expect(h.email.sent).toHaveLength(1);
    });

    it('falha de envio registra erro e reagenda com espera crescente', async () => {
      h.email.send = async () => {
        throw new Error('caixa cheia');
      };
      await h.invoices.deliver(invoice.id, 'EMAIL');
      const after = await reload(invoice.id);
      expect(after.deliveries[0]).toMatchObject({
        status: 'FAILED',
        lastError: 'caixa cheia',
        attempts: 1,
      });
      expect(h.scheduler.deliveries.at(-1)!.at).toBeDefined();
    });

    it('reenvio para outro destino', async () => {
      await h.invoices.resend(tenant.id, invoice.id, 'EMAIL', 'novo@x.com');
      await h.invoices.deliver(invoice.id, 'EMAIL');
      expect(h.email.sent.at(-1)!.to).toBe('novo@x.com');
    });

    it('reenvio exige destino', async () => {
      const noContact = await newSale('p3', {} as never);
      await h.invoices.issue(noContact.id);
      await expect(h.invoices.resend(tenant.id, noContact.id, 'WHATSAPP')).rejects.toThrow(
        /WhatsApp/
      );
    });
  });

  describe('ações do usuário', () => {
    it('cancela nota emitida', async () => {
      await h.invoices.issue(invoice.id);
      const cancelled = await h.invoices.cancel(
        tenant,
        invoice.id,
        '1',
        'Valor informado incorretamente'
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(h.provider.calls).toContain(`cancel:${invoice.id}`);
    });

    it('valida cancelamento', async () => {
      await expect(
        h.invoices.cancel(tenant, invoice.id, '5', 'Justificativa longa o bastante')
      ).rejects.toThrow(/reasonCode/);
      await expect(h.invoices.cancel(tenant, invoice.id, '1', 'curta')).rejects.toThrow(
        /15 caracteres/
      );
      await expect(
        h.invoices.cancel(tenant, invoice.id, '1', 'Justificativa longa o bastante')
      ).rejects.toThrow(/emitidas/);
      await h.invoices.issue(invoice.id);
      h.provider.cancelResult = { ok: false, errors: [{ code: 'E1', message: 'prazo expirado' }] };
      await expect(
        h.invoices.cancel(tenant, invoice.id, '1', 'Justificativa longa o bastante')
      ).rejects.toThrow(/recusou/);
    });

    it('reprocessa nota rejeitada', async () => {
      h.provider.behaviours = ['REJECT'];
      await h.invoices.issue(invoice.id);
      const requeued = await h.invoices.retry(tenant.id, invoice.id);
      expect(requeued.status).toBe('PENDING');
      expect((await h.invoices.issue(invoice.id))!.status).toBe('ISSUED');
    });

    it('lista, detalha e gera PDF', async () => {
      await h.invoices.issue(invoice.id);
      expect((await h.invoices.list(tenant.id, { status: ['ISSUED'] })).total).toBe(1);
      expect((await h.invoices.pdf(tenant, invoice.id)).toString()).toMatch(/^%PDF/);
      await expect(h.invoices.get('outro-tenant', invoice.id)).rejects.toThrow(/não encontrado/);
      await expect(h.invoices.getInternal('nope')).rejects.toThrow(/não encontrado/);
      const pending = await newSale('p4');
      await expect(h.invoices.pdf(tenant, pending.id)).rejects.toThrow(/ainda não foi emitida/);
    });
  });

  describe('reconcile (job recorrente)', () => {
    it('recupera travadas, reagenda vencidas e entregas pendentes', async () => {
      const stuck = await reload(invoice.id);
      await h.repos.invoices.update({
        ...stuck,
        status: 'PROCESSING',
        updatedAt: new Date(h.clock.now().getTime() - 20 * 60_000),
      });
      const issued = await newSale('p5');
      await h.invoices.issue(issued.id);
      h.clock.advance(20 * 60_000);
      h.scheduler.issues.length = 0;
      h.scheduler.deliveries.length = 0;

      const result = await h.invoices.reconcile();
      expect(result.recovered).toBe(1);
      expect(h.scheduler.issues.map((s) => s.invoiceId)).toContain(invoice.id);
      expect(h.scheduler.deliveries.map((d) => d.invoiceId)).toContain(issued.id);
    });
  });
});
