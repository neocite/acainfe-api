import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../../src/app.js';
import { buildContainer, Container } from '../../../src/config/container.js';
import { loadEnv } from '../../../src/config/env.js';
import { InMemoryEmailSender } from '../../../src/adapters/out/email/resend-email-sender.js';
import { InMemoryWhatsappSender } from '../../../src/adapters/out/whatsapp/uazapi-whatsapp-sender.js';
import { FakeExternalApis } from './fake-external-apis.js';
import { FakeGinfes } from './fake-ginfes.js';
import { FakePaulistana } from './fake-paulistana.js';
import { FakeSefin } from './fake-sefin.js';

export const ADMIN_KEY = 'admin-key-for-e2e-tests-0123456789';
export const APP_KEY = 'app-key-do-backend-replit-0123456789abcdef';
export const BILLING_WEBHOOK_SECRET = 'segredo-webhook-cobranca-acainfe';

export interface E2EApp {
  app: NestFastifyApplication;
  container: Container;
  sefin: FakeSefin;
  ginfes: FakeGinfes;
  paulistana: FakePaulistana;
  external: FakeExternalApis;
  email: InMemoryEmailSender;
  whatsapp: InMemoryWhatsappSender;
  baseUrl: string;
  close(): Promise<void>;
}

/** Sobe a aplicação completa (HTTP + MCP + fila Agenda) contra Mongo real e Sefin fake. */
export async function startE2EApp(envOverrides: Record<string, string> = {}): Promise<E2EApp> {
  const sefin = new FakeSefin();
  await sefin.start();
  const external = new FakeExternalApis();
  await external.start();
  const ginfes = new FakeGinfes();
  await ginfes.start();
  const paulistana = new FakePaulistana();
  await paulistana.start();
  const env = loadEnv({
    NODE_ENV: 'test',
    MONGODB_URI: process.env.E2E_MONGODB_URI!,
    MONGODB_DB: `e2e_${randomBytes(6).toString('hex')}`,
    ADMIN_API_KEY: ADMIN_KEY,
    APP_API_KEY: APP_KEY,
    BRASILAPI_URL: `${external.baseUrl}/cnpj/v1`,
    ABACATEPAY_API_URL: `${external.baseUrl}/v2`,
    BILLING_ABACATEPAY_API_KEY: external.validKey,
    BILLING_ABACATEPAY_WEBHOOK_SECRET: BILLING_WEBHOOK_SECRET,
    MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    LINK_SIGNING_SECRET: randomBytes(24).toString('hex'),
    PUBLIC_BASE_URL: 'https://api.acainfe.test',
    SEFIN_PRODUCTION_URL: `${sefin.baseUrl}/SefinNacional`,
    SEFIN_HOMOLOGATION_URL: `${sefin.baseUrl}/SefinNacional`,
    ADN_PRODUCTION_URL: sefin.baseUrl,
    ADN_HOMOLOGATION_URL: sefin.baseUrl,
    // Por padrão os testes emitem pelo nacional; o Ginfes é ligado por empresa (fiscalProvider).
    GINFES_CITIES: 'none',
    GINFES_PRODUCTION_URL: ginfes.url,
    GINFES_HOMOLOGATION_URL: ginfes.url,
    // SP também só por empresa (fiscalProvider PAULISTANA): os testes usam CNPJs de outros municípios.
    PAULISTANA_CITIES: 'none',
    PAULISTANA_URL: paulistana.url,
    GINFES_POLL_DELAYS_MS: '20,20,20,20',
    JOBS_ENABLED: 'true',
    JOBS_PROCESS_EVERY: '150',
    // Os testes usam certificados autoassinados; a exigência da ICP-Brasil tem teste próprio.
    CERTIFICATE_TRUST: 'any',
    // Sem lembretes automáticos nos e2e (o job rodaria no minuto 5 e mudaria a contagem de e-mails).
    ACTIVATION_ENABLED: 'false',
    ...envOverrides,
  });
  const email = new InMemoryEmailSender();
  const whatsapp = new InMemoryWhatsappSender();
  const container = await buildContainer(env, { email, whatsapp });
  const app = await createApp(container);
  await container.start();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = await app.getUrl();
  return {
    app,
    container,
    sefin,
    ginfes,
    paulistana,
    external,
    email,
    whatsapp,
    baseUrl: baseUrl.replace('[::1]', '127.0.0.1'),
    async close() {
      await app.close();
      await container.db.dropDatabase().catch(() => undefined);
      await container.close();
      await sefin.stop();
      await ginfes.stop();
      await paulistana.stop();
      await external.stop();
    },
  };
}

/** Espera até a condição ser verdadeira (jobs assíncronos). */
export async function eventually<T>(
  fn: () => Promise<T>,
  check: (v: T) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const start = Date.now();
  let last: T;
  do {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() - start < timeoutMs);
  throw new Error(
    `Condição não satisfeita em ${timeoutMs}ms. Último valor: ${JSON.stringify(last).slice(0, 2000)}`
  );
}
