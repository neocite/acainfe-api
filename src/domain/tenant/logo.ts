import { DomainError } from '../shared/domain-error.js';

export const MAX_LOGO_BYTES = 512 * 1024;

export interface Logo {
  contentType: 'image/png' | 'image/jpeg';
  data: Buffer;
}

/** Valida o logo pela assinatura do arquivo (não confia na extensão/Content-Type). PNG ou JPEG, até 512 KB. */
export function validateLogo(data: Buffer): Logo {
  if (!data?.length) throw DomainError.validation('Imagem do logo vazia');
  if (data.length > MAX_LOGO_BYTES)
    throw DomainError.validation('O logo deve ter no máximo 512 KB');
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: 'image/png', data };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return { contentType: 'image/jpeg', data };
  throw DomainError.validation('O logo deve ser PNG ou JPEG');
}
