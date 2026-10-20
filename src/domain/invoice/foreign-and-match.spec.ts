import { describe, expect, it } from 'vitest';
import { makeInvoice, makeTenant } from '../../../test/support/fixtures.js';
import { sampleNfse } from '../../../test/support/in-memory.js';
import { createCustomerRecord } from '../customer/customer-record.js';
import { createProduct, productWarnings } from '../product/product.js';
import { createTaxProfile } from '../product/tax-profile.js';
import { createCustomer } from '../sale/customer.js';
import { approximateTaxRateBps, planNumbering } from '../tenant/tenant.js';
import { nfseMatchesInvoice } from './invoice.js';

const NOW = new Date('2026-10-20T12:00:00Z');

describe('conferência da nota encontrada pelo DPS', () => {
  const inv = makeInvoice(); // R$ 1.500,00, CPF 52998224725
  it('confere valor e tomador; sem DPS ecoado não dá para conferir', () => {
    expect(
      nfseMatchesInvoice(
        { ...sampleNfse(), amountCents: 150000, customerDocument: '52998224725' },
        inv
      )
    ).toBe(true);
    expect(
      nfseMatchesInvoice(
        { ...sampleNfse(), amountCents: 100, customerDocument: '52998224725' },
        inv
      )
    ).toBe(false);
    expect(
      nfseMatchesInvoice(
        { ...sampleNfse(), amountCents: 150000, customerDocument: '11144477735' },
        inv
      )
    ).toBe(false);
    expect(
      nfseMatchesInvoice({ ...sampleNfse(), amountCents: 150000, customerDocument: '' }, inv)
    ).toBe(false);
    expect(nfseMatchesInvoice(sampleNfse(), inv)).toBe(true);
    const anon = makeInvoice({ customer: {} });
    expect(
      nfseMatchesInvoice({ ...sampleNfse(), amountCents: 150000, customerDocument: '' }, anon)
    ).toBe(true);
  });
});

describe('tomador no exterior', () => {
  it('valida país, NIF e exclusividade com CPF/CNPJ', () => {
    expect(
      createCustomer({
        name: 'John',
        phone: '+1 512 555 0100',
        foreign: { countryCode: 'us', nif: ' 123 ' },
      })
    ).toMatchObject({
      foreign: { countryCode: 'US', nif: '123' },
      phone: '15125550100',
    });
    expect(
      createCustomer({ name: 'Ana', foreign: { countryCode: 'PT' } }).foreign!.noNifReason
    ).toBe('2');
    expect(() => createCustomer({ foreign: { countryCode: 'US' } })).toThrow(/name/);
    expect(() => createCustomer({ name: 'x', foreign: { countryCode: 'BR' } })).toThrow(
      /CPF\/CNPJ/
    );
    expect(() => createCustomer({ name: 'x', foreign: { countryCode: 'USA' } })).toThrow(/ISO/);
    expect(() =>
      createCustomer({ name: 'x', taxId: '52998224725', foreign: { countryCode: 'US' } })
    ).toThrow(/não os dois/);
    expect(() =>
      createCustomer({ name: 'x', phone: '12', foreign: { countryCode: 'US' } })
    ).toThrow(/Telefone/);
    expect(() =>
      createCustomer({ name: 'x', foreign: { countryCode: 'US', nif: 'x'.repeat(41) } })
    ).toThrow(/40/);
  });

  it('cadastro de cliente estrangeiro e troca para CPF', () => {
    const r = createCustomerRecord(
      'c',
      't',
      { name: 'John', foreign: { countryCode: 'US', nif: '1' } },
      NOW
    );
    expect(r.foreign!.countryCode).toBe('US');
  });
});

describe('perfil tributário, avisos e tributos aproximados', () => {
  it('valida campos novos e alerta falta de NBS', () => {
    expect(() =>
      createTaxProfile({ nationalServiceCode: '010701', localServiceCode: ' ' })
    ).toThrow(/localServiceCode/);
    expect(() =>
      createTaxProfile({ nationalServiceCode: '010701', foreignTreatment: 'X' as never })
    ).toThrow(/EXPORT/);
    expect(() =>
      createTaxProfile({
        nationalServiceCode: '010701',
        foreignIbsCbs: { cst: '1', cClassTrib: '1', operationIndicator: '1' },
      })
    ).toThrow(/foreignIbsCbs/);
    const p = createProduct(
      'p',
      't',
      {
        name: 'A',
        taxProfile: { nationalServiceCode: '010701', localServiceCode: '8.02/103911/1551' },
      },
      NOW
    );
    expect(productWarnings(p)[0]).toMatch(/NBS/);
    expect(
      productWarnings({ ...p, taxProfile: { ...p.taxProfile!, nbsCode: '115013000' } })
    ).toEqual([]);
  });

  it('resolve o percentual de tributos: produto → empresa → Simples', () => {
    const profile = createTaxProfile({ nationalServiceCode: '010701' });
    expect(approximateTaxRateBps({ ...profile, approximateTaxRateBps: 1000 }, makeTenant())).toBe(
      1000
    );
    expect(
      approximateTaxRateBps(profile, makeTenant({ approximateTaxes: { rateBps: 1553 } }))
    ).toBe(1553);
    expect(
      approximateTaxRateBps(
        profile,
        makeTenant({ approximateTaxes: { federalRateBps: 1000, municipalRateBps: 200 } })
      )
    ).toBe(1200);
    expect(approximateTaxRateBps(profile, makeTenant())).toBe(600);
    expect(() => makeTenant({ approximateTaxes: { rateBps: 10100 } })).toThrow(
      /approximateTaxes.rate/
    );
    expect(() =>
      makeTenant({ approximateTaxes: { descriptionTemplate: 'x'.repeat(301) } })
    ).toThrow(/300/);
  });

  it('planeja numeração', () => {
    const t = { ...makeTenant(), lastDpsNumber: 10 };
    expect(planNumbering(t, {})).toEqual({ series: '1', lastNumber: 10 });
    expect(planNumbering(t, { series: '900' })).toEqual({ series: '900', lastNumber: 0 });
    expect(planNumbering(t, { series: '01', nextNumber: 20 })).toEqual({
      series: '01',
      lastNumber: 19,
    });
  });
});
