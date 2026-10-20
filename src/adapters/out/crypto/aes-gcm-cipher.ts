import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretCipher } from '../../../application/ports/services.js';

/**
 * Envelope encryption com AES-256-GCM: cada segredo recebe uma DEK aleatória, que é cifrada pela
 * master key (KEK). Formato: v1.<kekId>.<iv+tag+dekCifrada>.<iv+tag+dadosCifrados> (base64url).
 * A KEK vem do ambiente (OCI Vault injeta em produção) e pode ser rotacionada mantendo as antigas.
 */
export class AesGcmEnvelopeCipher implements SecretCipher {
  private readonly keys: Map<string, Buffer>;

  constructor(
    private readonly currentKeyId: string,
    keys: Record<string, string>
  ) {
    this.keys = new Map(Object.entries(keys).map(([id, b64]) => [id, Buffer.from(b64, 'base64')]));
    for (const [id, key] of this.keys) {
      if (key.length !== 32) throw new Error(`Master key ${id} deve ter 32 bytes (base64)`);
    }
    if (!this.keys.has(currentKeyId))
      throw new Error(`Master key atual ${currentKeyId} não configurada`);
  }

  encrypt(plain: Buffer): string {
    const dek = randomBytes(32);
    const sealedDek = seal(this.keys.get(this.currentKeyId)!, dek);
    const sealedData = seal(dek, plain);
    return [
      'v1',
      this.currentKeyId,
      sealedDek.toString('base64url'),
      sealedData.toString('base64url'),
    ].join('.');
  }

  decrypt(sealed: string): Buffer {
    const [version, keyId, dekPart, dataPart] = sealed.split('.');
    if (version !== 'v1' || !dekPart || !dataPart) throw new Error('Formato de segredo inválido');
    const kek = this.keys.get(keyId);
    if (!kek) throw new Error(`Master key ${keyId} indisponível`);
    const dek = open(kek, Buffer.from(dekPart, 'base64url'));
    return open(dek, Buffer.from(dataPart, 'base64url'));
  }
}

function seal(key: Buffer, data: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function open(key: Buffer, payload: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}
