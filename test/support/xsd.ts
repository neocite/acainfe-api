import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateXML } from 'xmllint-wasm';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'xsd');

/** Valida o XML contra os XSDs oficiais do leiaute nacional v1.01 (pacote 2026-02-09). */
export async function validateAgainstXsd(
  xml: string,
  mainSchema: string,
  /** Subpasta de test/fixtures/xsd (ex.: 'ginfes/sped'); padrão: leiaute nacional. */
  subdir = ''
): Promise<string[]> {
  const dir = join(DIR, subdir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.xsd'));
  const result = await validateXML({
    xml: [{ fileName: 'doc.xml', contents: xml }],
    schema: [{ fileName: mainSchema, contents: readFileSync(join(dir, mainSchema), 'utf8') }],
    preload: files
      .filter((f) => f !== mainSchema)
      .map((f) => ({ fileName: f, contents: readFileSync(join(dir, f), 'utf8') })),
  });
  return result.valid ? [] : result.errors.map((e) => e.rawMessage);
}
