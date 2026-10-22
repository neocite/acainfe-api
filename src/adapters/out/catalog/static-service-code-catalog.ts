import { ServiceCode, ServiceCodeCatalog } from '../../../application/ports/services.js';
import { SERVICE_CODES } from './service-codes.data.js';

const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Palavras do dia a dia que não aparecem no texto oficial da LC 116 (ex.: "design", "SaaS"). Só
 * ajudam a ACHAR o código; a escolha continua sendo do usuário e do contador.
 */
const KEYWORDS: Record<string, string> = {
  '010101': 'desenvolvimento software sistema site aplicativo app programacao',
  '010401': 'desenvolvimento software aplicativo app jogo game',
  '010301': 'hospedagem nuvem cloud servidor dados',
  '010501': 'saas software assinatura licenca plataforma aplicativo app',
  '010701': 'suporte manutencao ti',
  '080201': 'curso cursos treinamento mentoria workshop aula infoproduto palestra',
  '170101': 'consultoria assessoria',
  '170601': 'marketing publicidade propaganda anuncio trafego',
  '230101': 'design designer ux ui interface identidade visual logo logotipo branding grafico',
};

export class StaticServiceCodeCatalog implements ServiceCodeCatalog {
  private readonly codes: (ServiceCode & { haystack: string; words: Set<string> })[] =
    SERVICE_CODES.map(([code, item, description]) => {
      const haystack = normalize(`${code} ${item} ${description} ${KEYWORDS[code] ?? ''}`);
      return {
        nationalServiceCode: code,
        lc116Item: item,
        description,
        haystack,
        words: new Set(haystack.split(/[^a-z0-9.]+/).filter(Boolean)),
      };
    });

  search(query: string, limit: number): ServiceCode[] {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return (
      this.codes
        // Palavra inteira vale mais que pedaço (ex.: "ux" não deve preferir "auxiliares").
        .map((c) => ({
          c,
          score: terms.reduce(
            (sum, t) => sum + (c.words.has(t) ? 2 : c.haystack.includes(t) ? 1 : 0),
            0
          ),
        }))
        .filter((x) => !terms.length || x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ c: { haystack: _h, words: _w, ...code } }) => code)
    );
  }

  find(nationalServiceCode: string): ServiceCode | undefined {
    const found = this.codes.find((c) => c.nationalServiceCode === nationalServiceCode);
    if (!found) return undefined;
    const { haystack: _h, words: _w, ...code } = found;
    return code;
  }
}
