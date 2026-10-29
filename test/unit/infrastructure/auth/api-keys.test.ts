import { describe, expect, it } from 'vitest';
import {
  apiKeySecretMatches,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
} from '../../../../src/infrastructure/auth/api-keys';

const PEPPER = Buffer.alloc(32, 3);

describe('parseApiKey', () => {
  it('splits the key by its first two underscores', () => {
    expect(parseApiKey('ms_billing_abc')).toEqual({ clientId: 'billing', secret: 'abc' });
  });

  it('keeps underscores and dashes in the secret', () => {
    expect(parseApiKey('ms_crm-eu_a_b-c_d')).toEqual({ clientId: 'crm-eu', secret: 'a_b-c_d' });
  });

  it.each([
    'billing_abc',
    'mk_billing_abc',
    'ms_billing',
    'ms_billing_',
    'ms_ab_abc',
    'ms_Billing_abc',
    'ms_billing!_abc',
    `ms_${'a'.repeat(33)}_abc`,
    '',
  ])('rejects the malformed key %j', (raw) => {
    expect(parseApiKey(raw)).toBeNull();
  });
});

describe('generateApiKey', () => {
  it('generates a key with a 32-byte base64url secret that parses back', () => {
    const { key, secret } = generateApiKey('billing');

    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseApiKey(key)).toEqual({ clientId: 'billing', secret });
  });

  it('generates a different secret each time', () => {
    expect(generateApiKey('billing').secret).not.toBe(generateApiKey('billing').secret);
  });
});

describe('hashApiKeySecret', () => {
  it('hashes with HMAC-SHA256 and the pepper', () => {
    const hash = hashApiKeySecret('secret', PEPPER);

    expect(hash).toMatch(/^hmac-sha256:[A-Za-z0-9+/]+=*$/);
    expect(hash).not.toBe(hashApiKeySecret('secret', Buffer.alloc(32, 4)));
  });

  it('matches only the secret it was computed from', () => {
    const hash = hashApiKeySecret('secret', PEPPER);

    expect(apiKeySecretMatches('secret', hash, PEPPER)).toBe(true);
    expect(apiKeySecretMatches('other', hash, PEPPER)).toBe(false);
    expect(apiKeySecretMatches('secret', 'hmac-sha256:short', PEPPER)).toBe(false);
  });
});
