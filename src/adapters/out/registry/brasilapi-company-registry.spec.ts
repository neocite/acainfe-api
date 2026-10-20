import { describe, expect, it, vi } from 'vitest';
import { ACAINFE_USER_AGENT, BrasilApiCompanyRegistry } from './brasilapi-company-registry.js';

const company = {
  razao_social: 'AÇAÍ DIGITAL LTDA',
  codigo_municipio_ibge: 3548708,
  municipio: 'SAO BERNARDO DO CAMPO',
  uf: 'SP',
  opcao_pelo_simples: true,
  opcao_pelo_mei: false,
  descricao_situacao_cadastral: 'ATIVA',
  cnae_fiscal: 8599604,
  cnae_fiscal_descricao: 'Treinamento',
  cnaes_secundarios: [{ codigo: 6201501, descricao: 'Software' }],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('BrasilApiCompanyRegistry', () => {
  it('envia User-Agent (a Cloudflare bloqueia sem) e mapeia os dados', async () => {
    const fetchMock = vi.fn(async () => json(200, company));
    const info = await new BrasilApiCompanyRegistry(
      'https://x/cnpj/v1',
      fetchMock as never,
      0
    ).lookup('11222333000181');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x/cnpj/v1/11222333000181');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(ACAINFE_USER_AGENT);
    expect(info).toMatchObject({
      cityCode: '3548708',
      cityName: 'Sao Bernardo Do Campo',
      simplesNacional: true,
      active: true,
    });
    expect(info!.cnaes.map((c) => c.code)).toEqual(['8599604', '6201501']);
  });

  it('404 = CNPJ inexistente; erro momentâneo tenta de novo', async () => {
    expect(
      await new BrasilApiCompanyRegistry(
        'https://x',
        (async () => json(404, {})) as never,
        0
      ).lookup('1')
    ).toBeNull();
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(json(403, { error: 'Forbidden' }))
      .mockResolvedValueOnce(json(200, company));
    expect(
      (await new BrasilApiCompanyRegistry('https://x', flaky as never, 0).lookup('1'))!.legalName
    ).toBe('AÇAÍ DIGITAL LTDA');
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('indisponível vira erro amigável (503) depois da nova tentativa', async () => {
    const down = vi.fn(async () => json(503, {}));
    await expect(
      new BrasilApiCompanyRegistry('https://x', down as never, 0).lookup('1')
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringMatching(/Tente de novo/),
    });
    expect(down).toHaveBeenCalledTimes(2);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      new BrasilApiCompanyRegistry('https://x', offline as never, 0).lookup('1')
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
