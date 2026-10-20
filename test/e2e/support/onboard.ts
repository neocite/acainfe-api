import request from 'supertest';
import { generateTestPfx } from '../../support/test-certificate.js';
import { ADMIN_KEY, E2EApp } from './e2e-app.js';

/** Cria empresa + certificado + produtos padrão e devolve a API key. */
export async function onboardTenant(
  ctx: E2EApp,
  cnpj = '11222333000181',
  environment: 'PRODUCTION' | 'HOMOLOGATION' = 'PRODUCTION'
) {
  const http = request(ctx.baseUrl);
  const res = await http
    .post('/v1/tenants')
    .set('x-admin-key', ADMIN_KEY)
    .send({
      cnpj,
      legalName: 'Empresa E2E LTDA',
      municipalRegistration: '123456',
      taxRegime: 'SIMPLES_NACIONAL',
      simplesNacionalTaxRateBps: 600,
      email: 'e2e@empresa.com.br',
      environment,
      businessType: 'INFOPRODUCER',
    })
    .expect(201);
  const apiKey: string = res.body.apiKey;
  const { pfx, password } = generateTestPfx({ cnpj });
  await request(ctx.baseUrl)
    .post('/v1/certificates')
    .set('x-api-key', apiKey)
    .send({ pfxBase64: pfx.toString('base64'), password })
    .expect(201);
  for (const p of [
    {
      name: 'Suporte técnico',
      externalId: 'prod_suporte',
      defaultPriceCents: 10000,
      taxProfile: { nationalServiceCode: '010701', nbsCode: '115013000' },
    },
    {
      name: 'Consultoria',
      externalId: 'prod_consultoria',
      defaultPriceCents: 30000,
      taxProfile: { nationalServiceCode: '170101', nbsCode: '114011900' },
    },
  ]) {
    await request(ctx.baseUrl).post('/v1/products').set('x-api-key', apiKey).send(p).expect(201);
  }
  return { apiKey, tenantId: res.body.tenant.id as string };
}
