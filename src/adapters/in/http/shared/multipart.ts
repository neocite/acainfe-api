import '@fastify/multipart';
import type { AuthedRequest } from './support.js';

/** Lê um multipart com um arquivo e campos de texto. */
export async function readMultipart(
  req: AuthedRequest
): Promise<{ file?: Buffer; fields: Record<string, string> }> {
  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'file') file = await part.toBuffer();
    else fields[part.fieldname] = String(part.value);
  }
  return { file, fields };
}
