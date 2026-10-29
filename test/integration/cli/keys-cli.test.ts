import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleApiClientAdmin } from '../../../src/infrastructure/auth/drizzle-api-client-admin';
import { DrizzleApiClientRepository } from '../../../src/infrastructure/auth/drizzle-api-client-repository';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { runKeysCli } from '../../../src/interfaces/cli/keys-cli';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const PEPPER = Buffer.alloc(32, 3);
const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describe('keys CLI', () => {
  let admin: DrizzleApiClientAdmin;
  let repository: DrizzleApiClientRepository;

  beforeEach(async () => {
    await resetTables(db, { seedClients: false });
    const clock = new FakeClock();
    admin = new DrizzleApiClientAdmin(db, PEPPER, clock);
    repository = new DrizzleApiClientRepository(db, PEPPER, clock);
  });

  async function run(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runKeysCli(argv, admin, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const keyIn = (text: string) => /ms_billing_[A-Za-z0-9_-]+/.exec(text)?.[0] ?? '';

  it('creates a client and prints its new key once', async () => {
    expect(
      (
        await run(
          'client:create',
          '--id',
          'billing',
          '--name',
          'Facturación',
          '--transports',
          'api',
          '--from-domains',
          'example.com,*.example.org',
          '--rate-limit',
          '60',
        )
      ).code,
    ).toBe(0);

    const created = await run('key:create', '--client', 'billing');

    expect(created.code).toBe(0);
    expect(await repository.authenticate(keyIn(created.out))).toEqual({
      id: 'billing',
      name: 'Facturación',
      allowedTransports: ['api'],
      allowedFromDomains: ['example.com', '*.example.org'],
      rateLimitPerMinute: 60,
    });
    expect((await run('list')).out).not.toContain(keyIn(created.out));
  });

  it('creates a client with both transports by default', async () => {
    await run('client:create', '--id', 'billing', '--name', 'Facturación');
    const { out } = await run('key:create', '--client', 'billing');

    expect((await repository.authenticate(keyIn(out)))?.allowedTransports).toEqual(['smtp', 'api']);
  });

  it('updates, disables and enables a client', async () => {
    await run('client:create', '--id', 'billing', '--name', 'Facturación');
    const key = keyIn((await run('key:create', '--client', 'billing')).out);

    expect((await run('client:update', '--id', 'billing', '--rate-limit', '10')).code).toBe(0);
    expect((await repository.authenticate(key))?.rateLimitPerMinute).toBe(10);

    expect((await run('client:disable', '--id', 'billing')).code).toBe(0);
    expect(await repository.authenticate(key)).toBeNull();

    expect((await run('client:enable', '--id', 'billing')).code).toBe(0);
    expect(await repository.authenticate(key)).not.toBeNull();
  });

  it('revokes a key with immediate effect', async () => {
    await run('client:create', '--id', 'billing', '--name', 'Facturación');
    await run('key:create', '--client', 'billing', '--expires-at', '2027-10-29');
    const [summary] = await admin.list();
    const keyId = summary?.keys[0]?.keyId ?? '';
    expect(summary?.keys[0]?.expiresAt).toEqual(new Date('2027-10-29T00:00:00.000Z'));

    expect((await run('key:revoke', '--client', 'billing', '--key-id', keyId)).code).toBe(0);
    expect((await admin.list())[0]?.keys[0]?.status).toBe('revoked');
  });

  it('lists clients and keys without hashes', async () => {
    await run('client:create', '--id', 'billing', '--name', 'Facturación');
    await run('key:create', '--client', 'billing');
    const keyId = (await admin.list())[0]?.keys[0]?.keyId ?? '';

    const { code, out } = await run('list');

    expect(code).toBe(0);
    expect(out).toContain('billing');
    expect(out).toContain(keyId);
    expect(out).not.toContain('hmac-sha256');
  });

  it('reports an error from the store with exit code 1', async () => {
    await run('client:create', '--id', 'billing', '--name', 'Facturación');
    await run('key:create', '--client', 'billing');
    await run('key:create', '--client', 'billing');

    const third = await run('key:create', '--client', 'billing');

    expect(third.code).toBe(1);
    expect(third.err).toContain('active keys');
  });

  it.each([
    [[]],
    [['unknown:command']],
    [['client:create', '--name', 'Sin id']],
    [['client:create', '--id', 'billing', '--name', 'x', '--transports', 'fax']],
    [['client:create', '--id', 'billing', '--name', 'x', '--rate-limit', 'many']],
    [['key:create', '--client', 'billing', '--expires-at', 'tomorrow']],
    [['client:create', '--id', 'billing', '--name', 'x', '--unknown']],
  ])(
    'rejects the invalid arguments %j with usage and without touching the database',
    async (argv) => {
      const { code, err } = await run(...argv);

      expect(code).toBe(2);
      expect(err).toContain('Usage');
      expect(await admin.list()).toEqual([]);
    },
  );
});
