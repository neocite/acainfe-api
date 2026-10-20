import { SignedXml } from 'xml-crypto';
import { describe, expect, it } from 'vitest';
import { generateTestPfx } from '../../../../../test/support/test-certificate.js';
import { makeInvoice, makeTenant, NOW } from '../../../../../test/support/fixtures.js';
import { validateAgainstXsd } from '../../../../../test/support/xsd.js';
import { createTaxProfile } from '../../../../domain/product/tax-profile.js';
import { buildDpsId } from '../../../../domain/invoice/invoice.js';
import { openPfx } from '../../crypto/pfx.js';
import { buildCancellationXml, buildDpsXml } from './dps-builder.js';
import { signXml } from './xml-signer.js';

const opts = { appVersion: 'acainfe-0.1.0', now: NOW };
const pfx = generateTestPfx();
const contents = openPfx(pfx.pfx, pfx.password);

describe('buildDpsXml', () => {
  it('gera DPS válido no XSD oficial para ME/EPP do Simples com tomador CPF', async () => {
    const xml = buildDpsXml(makeInvoice(), makeTenant(), opts);
    expect(xml).toContain('<opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN>');
    expect(xml).toContain('<pTotTribSN>6.00</pTotTribSN>');
    expect(xml).not.toContain('<pAliq>');
    expect(xml).toContain('<dhEmi>2026-10-18T09:59:00-03:00</dhEmi>');
    expect(await validateAgainstXsd(signXml(xml, 'infDPS', contents), 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('pTotTribSN usa o percentual IBPT configurado na empresa', async () => {
    const xml = buildDpsXml(
      makeInvoice(),
      makeTenant({ approximateTaxes: { rateBps: 1553 } }),
      opts
    );
    expect(xml).toContain('<pTotTribSN>15.53</pTotTribSN>');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('o Id do DPS segue o padrão de 45 caracteres', () => {
    const id = buildDpsId('3548708', '11222333000181', '1', 123);
    expect(id).toBe('DPS354870821122233300018100001000000000000123');
    expect(id).toMatch(/^DPS\d{42}$/);
  });

  it('envia pAliq somente quando o ISS é retido', async () => {
    const invoice = makeInvoice({
      taxProfile: createTaxProfile({
        nationalServiceCode: '170101',
        issRateBps: 250,
        issRetention: 'TOMADOR',
      }),
      customer: {
        taxId: { kind: 'CNPJ', value: '11444777000161' },
        name: 'Cliente PJ',
        address: {
          street: 'Rua A',
          number: '10',
          district: 'Centro',
          cityCode: '3548708',
          zipCode: '09715-000',
        },
      },
    });
    const xml = buildDpsXml(invoice, makeTenant(), opts);
    expect(xml).toContain('<tpRetISSQN>2</tpRetISSQN><pAliq>2.50</pAliq>');
    expect(await validateAgainstXsd(signXml(xml, 'infDPS', contents), 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('omite o tomador quando não há documento (consumidor não identificado)', async () => {
    const xml = buildDpsXml(makeInvoice({ customer: { email: 'x@y.com' } }), makeTenant(), opts);
    expect(xml).not.toContain('<toma>');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('não optante usa indTotTrib e não envia regApTribSN; inclui IBS/CBS quando configurado', async () => {
    const invoice = makeInvoice({
      taxProfile: createTaxProfile({
        nationalServiceCode: '010701',
        ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
      }),
    });
    const xml = buildDpsXml(invoice, makeTenant({ taxRegime: 'LUCRO_PRESUMIDO' }), opts);
    expect(xml).toContain('<opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib>');
    expect(xml).toContain('<indTotTrib>0</indTotTrib>');
    expect(xml).toContain('<cClassTrib>000001</cClassTrib>');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('sem alíquota do Simples informada, usa a estimativa de 6% em pTotTribSN', async () => {
    const xml = buildDpsXml(
      makeInvoice(),
      makeTenant({ simplesNacionalTaxRateBps: undefined }),
      opts
    );
    expect(xml).toContain('<pTotTribSN>6.00</pTotTribSN>');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('sem inscrição municipal, emite sem o IM (dados vêm do cadastro nacional)', async () => {
    const xml = buildDpsXml(makeInvoice(), makeTenant({ municipalRegistration: undefined }), opts);
    expect(xml).not.toContain('<IM>');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('escapa caracteres especiais na discriminação', () => {
    const xml = buildDpsXml(
      makeInvoice({ serviceDescription: 'A & B <teste>' }),
      makeTenant(),
      opts
    );
    expect(xml).toContain('A &amp; B &lt;teste&gt;');
  });

  it('recusa retenções federais ainda não suportadas', () => {
    const invoice = makeInvoice({
      taxProfile: createTaxProfile({
        nationalServiceCode: '010701',
        federalRetentions: { irrfRateBps: 150 },
      }),
    });
    expect(() => buildDpsXml(invoice, makeTenant(), opts)).toThrow(/Retenções federais/);
  });
});

describe('assinatura XMLDSig', () => {
  it('assina infDPS com RSA-SHA256 e a assinatura é verificável', () => {
    const signed = signXml(buildDpsXml(makeInvoice(), makeTenant(), opts), 'infDPS', contents);
    expect(signed).toContain('<Reference URI="#DPS354870821122233300018100001000000000000123">');
    expect(signed).toContain('xmldsig-more#rsa-sha256');
    expect(signed).toMatch(/<\/infDPS><Signature xmlns="http:\/\/www.w3.org\/2000\/09\/xmldsig#">/);
    expect(signed).not.toMatch(/<X509Certificate>[^<]*\n/);

    const verifier = new SignedXml({ publicCert: contents.certificatePem });
    const signature = signed.match(/<Signature[\s\S]*<\/Signature>/)![0];
    verifier.loadSignature(signature);
    expect(verifier.checkSignature(signed)).toBe(true);
  });
});

describe('buildCancellationXml', () => {
  it('gera pedido de cancelamento válido no XSD', async () => {
    const key = '3548708211222333000181000000000012326100000000011';
    const accessKey = key.padEnd(50, '0');
    const xml = buildCancellationXml(
      accessKey,
      makeTenant(),
      { code: '1', description: 'Erro na emissão: valor incorreto' },
      opts
    );
    expect(xml).toContain(`Id="PRE${accessKey}101101"`);
    expect(
      await validateAgainstXsd(signXml(xml, 'infPedReg', contents), 'pedRegEvento_v1.01.xsd')
    ).toEqual([]);
  });
});

describe('tomador no exterior e tributos aproximados', () => {
  const foreignCustomer = {
    name: 'John Smith',
    email: 'john@example.com',
    foreign: {
      countryCode: 'US',
      nif: '123-45-6789',
      address: {
        street: 'Main St',
        number: '10',
        district: 'Downtown',
        city: 'Austin',
        region: 'TX',
        postalCode: '73301',
      },
    },
  };

  it('exportação de serviço: NIF, endereço no exterior, comExt e tribISSQN 3 válidos no XSD', async () => {
    const invoice = makeInvoice({
      customer: foreignCustomer,
      taxProfile: createTaxProfile({
        nationalServiceCode: '080201',
        ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
        foreignIbsCbs: { cst: '410', cClassTrib: '410004', operationIndicator: '100501' },
      }),
    });
    const xml = buildDpsXml(invoice, makeTenant(), opts);
    expect(xml).toContain('<NIF>123-45-6789</NIF>');
    expect(xml).toContain('<endExt><cPais>US</cPais><cEndPost>73301</cEndPost>');
    expect(xml).toContain('<comExt><mdPrestacao>1</mdPrestacao>');
    expect(xml).toContain('<tribISSQN>3</tribISSQN><cPaisResult>US</cPaisResult>');
    expect(xml).toContain('<cClassTrib>410004</cClassTrib>');
    expect(await validateAgainstXsd(signXml(xml, 'infDPS', contents), 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('consumidor sem CPF/CNPJ: sem tomador e sem grupo IBS/CBS (evita E0234)', async () => {
    const taxProfile = createTaxProfile({
      nationalServiceCode: '080201',
      nbsCode: '122051900',
      ibsCbs: { cst: '000', cClassTrib: '000001', operationIndicator: '100301' },
    });
    const address = {
      street: 'R. Luiz Pereira Barreto',
      number: '1248',
      district: 'Centro',
      cityCode: '3502804',
      zipCode: '16015445',
    };
    const anonymous = buildDpsXml(
      makeInvoice({ customer: { name: 'Cristiano', address }, taxProfile }),
      makeTenant(),
      opts
    );
    expect(anonymous).not.toContain('<toma>');
    expect(anonymous).not.toContain('<IBSCBS>');
    expect(await validateAgainstXsd(anonymous, 'DPS_v1.01.xsd')).toEqual([]);

    const identified = buildDpsXml(
      makeInvoice({
        customer: { name: 'Cristiano', taxId: { kind: 'CPF', value: '52998224725' }, address },
        taxProfile,
      }),
      makeTenant(),
      opts
    );
    expect(identified).toContain('<toma><CPF>52998224725</CPF>');
    expect(identified).toContain('<cMun>3502804</cMun>');
    expect(identified).toContain('<cIndOp>100301</cIndOp>');
    expect(await validateAgainstXsd(identified, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('estrangeiro sem NIF usa cNaoNIF; tratamento TAXABLE tributa normalmente', async () => {
    const invoice = makeInvoice({
      customer: { name: 'Maria', foreign: { countryCode: 'PT', noNifReason: '2' } },
      taxProfile: createTaxProfile({ nationalServiceCode: '080201', foreignTreatment: 'TAXABLE' }),
    });
    const xml = buildDpsXml(invoice, makeTenant(), opts);
    expect(xml).toContain('<cNaoNIF>2</cNaoNIF>');
    expect(xml).toContain('<tribISSQN>1</tribISSQN>');
    expect(xml).not.toContain('cPaisResult');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });

  it('tributos aproximados: detalhado (IBPT) para não optante e texto na discriminação', async () => {
    const tenant = makeTenant({
      taxRegime: 'LUCRO_PRESUMIDO',
      approximateTaxes: {
        federalRateBps: 1345,
        stateRateBps: 0,
        municipalRateBps: 208,
        descriptionTemplate:
          'Valor aprox. dos tributos: R$ [ValorTributos] ([PercentualTributos]%). Fonte: IBPT',
      },
    });
    const xml = buildDpsXml(makeInvoice(), tenant, opts);
    expect(xml).toContain(
      '<pTotTrib><pTotTribFed>13.45</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>2.08</pTotTribMun></pTotTrib>'
    );
    expect(xml).toContain('Valor aprox. dos tributos: R$ 232,95 (15,53%). Fonte: IBPT');
    expect(await validateAgainstXsd(xml, 'DPS_v1.01.xsd')).toEqual([]);
  });
});
