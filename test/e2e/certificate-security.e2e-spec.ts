import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateTestPfx } from '../support/test-certificate.js';
import { APP_KEY, E2EApp, startE2EApp } from './support/e2e-app.js';
import { brasilApiCompany } from './support/fake-external-apis.js';

const CNPJ = '11222333000181';
const TEST_CNPJ = '99000001000101';

/**
 * Ataque relatado em 21/10/2026: certificado autoassinado com o CNPJ de outra empresa dava acesso a
 * ela e trocava o certificado. Aqui a exigência da ICP-Brasil está ligada, como em produção.
 */
describe('Certificado: só e-CNPJ da ICP-Brasil; ninguém assume empresa de outro', () => {
  let ctx: E2EApp;
  const http = () => request(ctx.baseUrl);
  const asUser = (r: request.Test, id: string, email: string) =>
    r.set('x-app-key', APP_KEY).set('x-user-id', id).set('x-user-email', email);
  const send = (id: string, email: string, cnpj: string) => {
    const { pfx, password } = generateTestPfx({ cnpj });
    return asUser(http().post('/v1/app/onboarding/certificate'), id, email).send({
      pfxBase64: pfx.toString('base64'),
      password,
    });
  };

  beforeAll(async () => {
    ctx = await startE2EApp({ CERTIFICATE_TRUST: 'icp-brasil', TEST_COMPANY_CNPJS: TEST_CNPJ });
    ctx.external.companies.set(CNPJ, brasilApiCompany(CNPJ));
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('autoassinado com CNPJ real é recusado e não cria nada', async () => {
    const res = await send('atacante', 'atacante@x.com', CNPJ).expect(422);
    expect(res.body.message).toMatch(/não é um e-CNPJ válido da ICP-Brasil/);
    expect(await ctx.container.db.collection('tenants').countDocuments()).toBe(0);
  });

  it('CNPJ de teste aceita autoassinado; outra conta não assume a empresa', async () => {
    const owner = await send('dono', 'dono@x.com', TEST_CNPJ).expect(201);
    const tenantId = owner.body.tenant.id as string;
    const certBefore = await ctx.container.db
      .collection('certificates')
      .findOne({ tenantId, active: true });

    const intruder = await send('intruso', 'intruso@x.com', TEST_CNPJ).expect(409);
    expect(intruder.body.message).toMatch(/já está cadastrada/);

    const tenant = await ctx.container.db.collection('tenants').findOne({ _id: tenantId as never });
    expect(tenant!.ownerUserIds).toHaveLength(1);
    const certAfter = await ctx.container.db
      .collection('certificates')
      .findOne({ tenantId, active: true });
    expect(certAfter!._id).toEqual(certBefore!._id);
    // Para quem não é dono, a empresa nem aparece (404, sem revelar que existe).
    await asUser(http().get(`/v1/app/companies/${tenantId}`), 'intruso', 'intruso@x.com').expect(
      404
    );
    expect(ctx.email.sent.some((m) => /Tentativa de acesso/.test(m.subject))).toBe(true);
  });
});
