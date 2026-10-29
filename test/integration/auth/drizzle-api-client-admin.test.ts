import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiClientAdminError,
  DrizzleApiClientAdmin,
  type ClientSettings,
} from '../../../src/infrastructure/auth/drizzle-api-client-admin';
import { DrizzleApiClientRepository } from '../../../src/infrastructure/auth/drizzle-api-client-repository';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { apiKeys } from '../../../src/infrastructure/db/schema';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const PEPPER = Buffer.alloc(32, 3);
const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

const SETTINGS: ClientSettings = {
  name: 'Facturación',
  allowedTransports: ['smtp', 'api'],
  allowedFromDomains: null,
  rateLimitPerMinute: null,
};

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ApiClientAdminError))
    throw new Error(`expected an admin error, got ${String(error)}`);
  return error.code;
}

describe('DrizzleApiClientAdmin', () => {
  let clock: FakeClock;
  let admin: DrizzleApiClientAdmin;
  let repository: DrizzleApiClientRepository;

  beforeEach(async () => {
    await resetTables(db, { seedClients: false });
    clock = new FakeClock();
    admin = new DrizzleApiClientAdmin(db, PEPPER, clock);
    repository = new DrizzleApiClientRepository(db, PEPPER, clock);
  });

  it('creates a client whose new key authenticates', async () => {
    await admin.createClient('billing', SETTINGS);

    const { key } = await admin.createKey('billing');

    expect(await repository.authenticate(key)).toEqual({
      id: 'billing',
      name: 'Facturación',
      allowedTransports: ['smtp', 'api'],
    });
  });

  it.each(['ab', 'Billing', 'bill_ing', 'a'.repeat(33)])(
    'rejects the invalid client id %j',
    async (id) => {
      expect(await errorCodeOf(admin.createClient(id, SETTINGS))).toBe('INVALID_CLIENT_ID');
    },
  );

  it('rejects a client id that already exists', async () => {
    await admin.createClient('billing', SETTINGS);

    expect(await errorCodeOf(admin.createClient('billing', SETTINGS))).toBe('CLIENT_EXISTS');
  });

  it('updates the settings of a client', async () => {
    await admin.createClient('billing', SETTINGS);
    const { key } = await admin.createKey('billing');

    await admin.updateClient('billing', {
      allowedTransports: ['api'],
      allowedFromDomains: ['example.com'],
      rateLimitPerMinute: 30,
    });

    expect(await repository.authenticate(key)).toEqual({
      id: 'billing',
      name: 'Facturación',
      allowedTransports: ['api'],
      allowedFromDomains: ['example.com'],
      rateLimitPerMinute: 30,
    });
  });

  it.each([
    ['update', (a: DrizzleApiClientAdmin) => a.updateClient('nobody', { name: 'x' })],
    ['disable', (a: DrizzleApiClientAdmin) => a.setClientStatus('nobody', 'disabled')],
    ['create a key for', (a: DrizzleApiClientAdmin) => a.createKey('nobody')],
  ])('fails to %s an unknown client', async (_action, act) => {
    expect(await errorCodeOf(act(admin))).toBe('CLIENT_NOT_FOUND');
  });

  it('disables and enables a client with immediate effect', async () => {
    await admin.createClient('billing', SETTINGS);
    const { key } = await admin.createKey('billing');

    await admin.setClientStatus('billing', 'disabled');
    expect(await repository.authenticate(key)).toBeNull();

    await admin.setClientStatus('billing', 'active');
    expect(await repository.authenticate(key)).not.toBeNull();
  });

  it('stores only the hash of a key', async () => {
    await admin.createClient('billing', SETTINGS);
    const { key, keyId } = await admin.createKey('billing');

    const rows = await db.select().from(apiKeys);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.keyId).toBe(keyId);
    expect(rows[0]?.hash).toMatch(/^hmac-sha256:/);
    expect(JSON.stringify(rows)).not.toContain(key.split('_').slice(2).join('_'));
  });

  it('rejects a third active key, but not counting revoked or expired keys', async () => {
    await admin.createClient('billing', SETTINGS);
    const revoked = await admin.createKey('billing');
    await admin.revokeKey('billing', revoked.keyId);
    await admin.createKey('billing', { expiresAt: new Date(clock.now().getTime() + 1_000) });
    await admin.createKey('billing');
    clock.advance(1_000);
    await admin.createKey('billing');

    expect(await errorCodeOf(admin.createKey('billing'))).toBe('TOO_MANY_ACTIVE_KEYS');
  });

  it('never exceeds two active keys with simultaneous creations', async () => {
    await admin.createClient('billing', SETTINGS);
    await admin.createKey('billing');

    const results = await Promise.allSettled([
      admin.createKey('billing'),
      admin.createKey('billing'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const active = (await admin.list())[0]?.keys.filter((key) => key.status === 'active');
    expect(active).toHaveLength(2);
  });

  it('revokes a key with immediate effect', async () => {
    await admin.createClient('billing', SETTINGS);
    const { key, keyId } = await admin.createKey('billing');

    await admin.revokeKey('billing', keyId);

    expect(await repository.authenticate(key)).toBeNull();
    expect(await errorCodeOf(admin.revokeKey('billing', 'k_unknown'))).toBe('KEY_NOT_FOUND');
  });

  it('lists clients and keys without hashes', async () => {
    await admin.createClient('billing', { ...SETTINGS, rateLimitPerMinute: 60 });
    const { keyId } = await admin.createKey('billing');

    const clients = await admin.list();

    expect(clients).toEqual([
      {
        id: 'billing',
        status: 'active',
        ...SETTINGS,
        rateLimitPerMinute: 60,
        keys: [
          { keyId, status: 'active', createdAt: clock.now(), expiresAt: null, revokedAt: null },
        ],
      },
    ]);
    expect(JSON.stringify(clients)).not.toContain('hmac-sha256');
  });
});
