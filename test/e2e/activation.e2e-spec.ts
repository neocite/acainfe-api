import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_KEY, APP_KEY, E2EApp, startE2EApp } from './support/e2e-app.js';

describe('Régua de ativação: funil no admin e descadastro pelo link', () => {
  let ctx: E2EApp;
  const http = () => request(ctx.baseUrl);

  beforeAll(async () => {
    ctx = await startE2EApp();
  });
  afterAll(async () => {
    await ctx?.close();
  });

  it('quem criou conta e não enviou o certificado aparece no funil; o link para os lembretes', async () => {
    const me = await http()
      .get('/v1/app/me')
      .set('x-app-key', APP_KEY)
      .set('x-user-id', 'replit-lead')
      .set('x-user-email', 'lead@exemplo.com')
      .expect(200);
    const userId = me.body.user.id as string;

    await http().get('/v1/admin/activation').expect(401);
    const funnel = await http()
      .get('/v1/admin/activation')
      .set('x-admin-key', ADMIN_KEY)
      .expect(200);
    expect(funnel.body).toEqual([
      expect.objectContaining({
        userId,
        email: 'lead@exemplo.com',
        stage: 'NO_CERTIFICATE',
        optedOut: false,
      }),
    ]);

    const url = new URL(ctx.container.links.unsubscribeUrl(userId)!);
    await http().get(`${url.pathname}?u=${userId}&sig=forjada`).expect(404);
    const ok = await http().get(`${url.pathname}${url.search}`).expect(200);
    expect(ok.text).toContain('sem mais lembretes');
    const after = await http()
      .get('/v1/admin/activation')
      .set('x-admin-key', ADMIN_KEY)
      .expect(200);
    expect(after.body[0].optedOut).toBe(true);
  });
});
