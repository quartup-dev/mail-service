import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UndecryptableSecretError } from '../../../../src/domain/errors';
import { AesGcmSecretBox } from '../../../../src/infrastructure/crypto/aes-gcm-secret-box';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const KEY_C = Buffer.alloc(32, 3);

const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

describe('AesGcmSecretBox', () => {
  it('decrypts what it encrypts', () => {
    const box = new AesGcmSecretBox({ active: KEY_A });

    expect(box.decrypt(box.encrypt('{"pass":"s3cret"}'))).toBe('{"pass":"s3cret"}');
  });

  it('prefixes the ciphertext with the active key id and encodes it in base64url', () => {
    const box = new AesGcmSecretBox({ active: KEY_A });

    const [keyId, payload] = box.encrypt('s3cret').split(':');

    expect(keyId).toBe(keyIdOf(KEY_A));
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    // IV de 12 bytes + tag de 16 bytes + texto cifrado de la misma longitud que el original
    expect(Buffer.from(payload ?? '', 'base64url')).toHaveLength(12 + 16 + 's3cret'.length);
  });

  it('produces a different ciphertext each time thanks to a random IV', () => {
    const box = new AesGcmSecretBox({ active: KEY_A });

    expect(box.encrypt('s3cret')).not.toBe(box.encrypt('s3cret'));
  });

  it('decrypts with the previous key what was encrypted before a rotation', () => {
    const beforeRotation = new AesGcmSecretBox({ active: KEY_A });
    const afterRotation = new AesGcmSecretBox({ active: KEY_B, previous: KEY_A });

    expect(afterRotation.decrypt(beforeRotation.encrypt('s3cret'))).toBe('s3cret');
  });

  it('rejects a ciphertext whose key id matches neither the active nor the previous key', () => {
    const otherBox = new AesGcmSecretBox({ active: KEY_C });
    const box = new AesGcmSecretBox({ active: KEY_B, previous: KEY_A });

    expect(() => box.decrypt(otherBox.encrypt('s3cret'))).toThrow(UndecryptableSecretError);
  });

  it('rejects a tampered ciphertext', () => {
    const box = new AesGcmSecretBox({ active: KEY_A });
    const [keyId, payload = ''] = box.encrypt('s3cret').split(':');
    const bytes = Buffer.from(payload, 'base64url');
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;

    expect(() => box.decrypt(`${keyId}:${bytes.toString('base64url')}`)).toThrow(
      UndecryptableSecretError,
    );
  });

  it.each(['', 'no-separator', `${keyIdOf(KEY_A)}:`, `${keyIdOf(KEY_A)}:c2hvcnQ`])(
    'rejects the malformed ciphertext %j',
    (cipher) => {
      const box = new AesGcmSecretBox({ active: KEY_A });

      expect(() => box.decrypt(cipher)).toThrow(UndecryptableSecretError);
    },
  );
});
