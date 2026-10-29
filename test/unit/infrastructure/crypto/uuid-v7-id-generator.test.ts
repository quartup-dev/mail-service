import { describe, expect, it } from 'vitest';
import { UuidV7IdGenerator } from '../../../../src/infrastructure/crypto/uuid-v7-id-generator';

// Versión 7 en el nibble 13 y variante RFC 9562 (8, 9, a o b) en el 17
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7IdGenerator', () => {
  it('generates distinct version 7 UUIDs', () => {
    const ids = new UuidV7IdGenerator();

    const generated = Array.from({ length: 100 }, () => ids.next());

    for (const id of generated) expect(id).toMatch(UUID_V7);
    expect(new Set(generated).size).toBe(100);
  });
});
