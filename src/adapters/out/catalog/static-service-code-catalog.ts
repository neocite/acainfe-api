import { ServiceCode, ServiceCodeCatalog } from '../../../application/ports/services.js';
import { SERVICE_CODES } from './service-codes.data.js';

const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class StaticServiceCodeCatalog implements ServiceCodeCatalog {
  private readonly codes: (ServiceCode & { haystack: string })[] = SERVICE_CODES.map(
    ([code, item, description]) => ({
      nationalServiceCode: code,
      lc116Item: item,
      description,
      haystack: normalize(`${code} ${item} ${description}`),
    })
  );

  search(query: string, limit: number): ServiceCode[] {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    return this.codes
      .map((c) => ({ c, score: terms.filter((t) => c.haystack.includes(t)).length }))
      .filter((x) => !terms.length || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ c: { haystack: _h, ...code } }) => code);
  }

  find(nationalServiceCode: string): ServiceCode | undefined {
    const found = this.codes.find((c) => c.nationalServiceCode === nationalServiceCode);
    if (!found) return undefined;
    const { haystack: _h, ...code } = found;
    return code;
  }
}
