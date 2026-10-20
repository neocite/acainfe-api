import { zipSync } from 'fflate';
import { ArchiveBuilder } from '../../../application/ports/services.js';

/** ZIP em memória (PDFs já são comprimidos; XML/CSV comprimem bem). */
export class FflateArchiveBuilder implements ArchiveBuilder {
  zip(files: { name: string; content: Buffer }[]): Buffer {
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) entries[f.name] = new Uint8Array(f.content);
    return Buffer.from(zipSync(entries, { level: 6 }));
  }
}
