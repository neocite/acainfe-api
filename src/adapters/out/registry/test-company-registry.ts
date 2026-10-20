import { CompanyInfo, CompanyRegistry } from '../../../application/ports/services.js';

/**
 * CNPJs de teste (env TEST_COMPANY_CNPJS): devolvem uma empresa fictícia do Simples em São Bernardo do
 * Campo, sem consultar a Receita, para testar o onboarding com um certificado autoassinado. Qualquer
 * outro CNPJ segue para o cadastro real.
 */
export class TestCompanyRegistry implements CompanyRegistry {
  private readonly testCnpjs: Set<string>;

  constructor(
    private readonly inner: CompanyRegistry,
    testCnpjs: string[]
  ) {
    this.testCnpjs = new Set(testCnpjs.map((c) => c.replace(/\D/g, '')).filter(Boolean));
  }

  async lookup(cnpj: string): Promise<CompanyInfo | null> {
    const digits = cnpj.replace(/\D/g, '');
    if (!this.testCnpjs.has(digits)) return this.inner.lookup(cnpj);
    return {
      cnpj: digits,
      legalName: `EMPRESA TESTE SBC LTDA`,
      tradeName: 'Teste açaínfe',
      cityCode: '3548708',
      cityName: 'Sao Bernardo Do Campo',
      uf: 'SP',
      simplesNacional: true,
      mei: false,
      active: true,
      situation: 'ATIVA',
      cnaes: [
        {
          code: '8599604',
          description: 'Treinamento em desenvolvimento profissional e gerencial',
          primary: true,
        },
        {
          code: '6203100',
          description: 'Desenvolvimento e licenciamento de programas de computador não-customizáveis',
          primary: false,
        },
      ],
      address: {
        street: 'Rua Marechal Deodoro',
        number: '100',
        district: 'Centro',
        zipCode: '09715000',
      },
    };
  }
}
