import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SecretBox } from '../../application/ports/secret-box';
import { UndecryptableSecretError } from '../../domain/errors';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBoxKeys {
  active: Buffer;
  previous?: Buffer;
}

// Formato: <keyId>:<base64url(iv ‖ tag ‖ ciphertext)>. keyId son los 8 primeros
// caracteres hex del SHA-256 de la clave
export class AesGcmSecretBox implements SecretBox {
  private readonly activeKey: Buffer;
  private readonly activeKeyId: string;
  private readonly keysById: Map<string, Buffer>;

  constructor(keys: SecretBoxKeys) {
    this.activeKey = keys.active;
    this.activeKeyId = keyIdOf(keys.active);
    this.keysById = new Map([[this.activeKeyId, keys.active]]);
    if (keys.previous) this.keysById.set(keyIdOf(keys.previous), keys.previous);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.activeKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return `${this.activeKeyId}:${payload.toString('base64url')}`;
  }

  decrypt(cipher: string): string {
    const separator = cipher.indexOf(':');
    if (separator === -1) throw new UndecryptableSecretError('Malformed ciphertext');

    const key = this.keysById.get(cipher.slice(0, separator));
    if (!key) throw new UndecryptableSecretError('Ciphertext encrypted with an unknown key');

    const payload = Buffer.from(cipher.slice(separator + 1), 'base64url');
    if (payload.length < IV_BYTES + TAG_BYTES) {
      throw new UndecryptableSecretError('Malformed ciphertext');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, payload.subarray(0, IV_BYTES));
      decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new UndecryptableSecretError('Ciphertext failed authentication', { cause: error });
    }
  }
}

function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
