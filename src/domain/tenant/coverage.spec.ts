import { describe, expect, it } from 'vitest';
import { makeTenant, NOW } from '../../../test/support/fixtures.js';
import { createUser, updateUserProfile } from '../account/user.js';
import {
  createImportedProduct,
  createProduct,
  isSellable,
  updateProduct,
} from '../product/product.js';
import { coversRegime, createCoverage, evaluateAvailability } from './coverage.js';
import { activateTenant, tenantReadiness } from './tenant.js';

describe('cobertura por município e regime', () => {
  const sbc = createCoverage({ cityCode: '3548708', simples: true, others: false }, NOW);
  it('avalia disponibilidade', () => {
    expect(evaluateAvailability(sbc, 'SIMPLES_NACIONAL', 'SBC')).toEqual({ status: 'READY' });
    expect(evaluateAvailability(sbc, 'MEI', 'SBC')).toEqual({ status: 'READY' });
    expect(evaluateAvailability(sbc, 'LUCRO_REAL', 'SBC')).toMatchObject({ status: 'WAITLIST' });
    expect(evaluateAvailability(null, 'MEI', 'Recife/PE')).toMatchObject({
      status: 'WAITLIST',
      reason: expect.stringContaining('Recife'),
    });
    expect(coversRegime(sbc, 'LUCRO_PRESUMIDO')).toBe(false);
    expect(() => createCoverage({ cityCode: '1', simples: true, others: true }, NOW)).toThrow(
      /IBGE/
    );
  });

  it('readiness e ativação', () => {
    const t = makeTenant({
      municipalRegistration: undefined,
      status: 'WAITLIST',
      waitlistReason: 'x',
    });
    expect(tenantReadiness(t, false).missing.map((m) => m.field)).toEqual([
      'status',
      'certificate',
      'numbering',
      'businessType',
    ]);
    expect(tenantReadiness(t, false).recommended.map((m) => m.field)).toEqual([
      'municipalRegistration',
      'approximateTaxes',
    ]);
    // Sistema da prefeitura que exige o CCM (ex.: Ginfes de SBC): vira pendência.
    expect(
      tenantReadiness(t, true, { municipalRegistrationRequired: true }).missing.map((m) => m.field)
    ).toContain('municipalRegistration');
    const active = activateTenant(t, NOW);
    expect(active).toMatchObject({ status: 'ACTIVE', waitlist: undefined, activatedAt: NOW });
    expect(activateTenant(active, NOW)).toBe(active);
    expect(
      tenantReadiness(
        {
          ...active,
          municipalRegistration: '1',
          numberingConfirmedAt: NOW,
          businessType: 'INFOPRODUCER',
          approximateTaxes: { rateBps: 1553, descriptionTemplate: 'Fonte: IBPT' },
        },
        true
      )
    ).toEqual({
      canIssue: true,
      missing: [],
      recommended: [],
    });
  });
});

describe('produto importado', () => {
  it('fica pendente até a tributação ser definida', () => {
    const p = createImportedProduct(
      'p',
      't',
      { externalId: 'prod_1', name: 'Curso', priceCents: 100 },
      NOW
    );
    expect(p).toMatchObject({
      taxStatus: 'PENDING_REVIEW',
      importedFrom: { source: 'ABACATEPAY' },
    });
    expect(isSellable(p)).toBe(false);
    expect(() => updateProduct(p, { taxProfile: { issRateBps: 200 } }, NOW)).toThrow(
      /nationalServiceCode/
    );
    expect(updateProduct(p, { name: 'Curso 2' }, NOW).taxStatus).toBe('PENDING_REVIEW');
    const ok = updateProduct(
      p,
      { taxProfile: { nationalServiceCode: '080201', nbsCode: '122051900' } },
      NOW,
      'MCP',
      'CNAE 8599'
    );
    expect(isSellable(ok)).toBe(true);
    expect(ok.taxConfirmation).toMatchObject({ via: 'MCP', note: 'CNAE 8599' });
    expect(() => createImportedProduct('p', 't', { externalId: ' ', name: 'x' }, NOW)).toThrow(
      /externalId/
    );
    expect(
      isSellable({
        ...createProduct(
          'q',
          't',
          { name: 'A', taxProfile: { nationalServiceCode: '010101' } },
          NOW
        ),
        active: false,
      })
    ).toBe(false);
  });
});

describe('usuário', () => {
  it('cria e atualiza perfil', () => {
    const u = createUser('u', { externalId: ' r1 ', email: 'X@Y.com' }, NOW);
    expect(u).toMatchObject({ externalId: 'r1', email: 'x@y.com', tenantIds: [] });
    expect(updateUserProfile(u, { whatsapp: '11999990000', name: 'Ana' }, NOW)).toMatchObject({
      whatsapp: '5511999990000',
      name: 'Ana',
    });
    expect(() => createUser('u', { externalId: '', email: 'a@b.com' }, NOW)).toThrow(/externalId/);
  });
});
