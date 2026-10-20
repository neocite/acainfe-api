import type { Db } from 'mongodb';

/**
 * Regra do açaínfe: todo valor numérico persistido é inteiro (centavos, pontos-base, contadores).
 * Varre todas as coleções e devolve os caminhos com número não inteiro.
 */
export async function findNonIntegerNumbers(db: Db): Promise<string[]> {
  const problems: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) problems.push(`${path} = ${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (
      value &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      value.constructor?.name === 'Object'
    ) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  for (const { name } of await db.listCollections().toArray()) {
    for (const doc of await db.collection(name).find().toArray()) {
      // rawPayload guarda o JSON original do gateway como veio (não é dado do açaínfe).
      const { rawPayload: _raw, ...rest } = doc as Record<string, unknown>;
      walk(rest, `${name}#${String(doc._id)}`);
    }
  }
  return problems;
}
