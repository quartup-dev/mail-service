import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DrizzleApiClientAdmin } from '../../../src/infrastructure/auth/drizzle-api-client-admin';
import { loadConfig } from '../../../src/infrastructure/config';
import { createApiContainer } from '../../../src/infrastructure/container';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { emails } from '../../../src/infrastructure/db/schema';
import { createLogger } from '../../../src/infrastructure/logger';
import { SystemClock } from '../../../src/infrastructure/system-clock';
import { apiRequest, smtpRequest } from '../../support/email-requests';
import { resetTables, TEST_DATABASE_URL, TEST_REDIS_URL } from '../../support/integration';

const PEPPER = Buffer.alloc(32, 3).toString('base64');
const REDIS_DB_URL = `${TEST_REDIS_URL}/15`; // base dedicada: se vacía en cada test

const config = loadConfig('api', {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: REDIS_DB_URL,
  SMTP_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  API_KEY_PEPPER: PEPPER,
  SMTP_ALLOWED_PRIVATE_HOSTS: 'localhost',
  LOG_LEVEL: 'silent',
});

const { db, pool } = connectDatabase(TEST_DATABASE_URL);
const redis = new Redis(REDIS_DB_URL);

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('API with PostgreSQL and Redis', () => {
  const apps: FastifyInstance[] = [];
  let admin: DrizzleApiClientAdmin;

  beforeEach(async () => {
    await resetTables(db, { seedClients: false });
    await redis.flushdb();
    admin = new DrizzleApiClientAdmin(db, Buffer.from(PEPPER, 'base64'), new SystemClock());
    await admin.createClient('crm', {
      name: 'CRM',
      allowedTransports: ['smtp', 'api'],
      allowedFromDomains: null,
      rateLimitPerMinute: null,
    });
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  function startApp(): FastifyInstance {
    const { app } = createApiContainer(config, createLogger({ level: 'silent' }));
    apps.push(app);
    return app;
  }

  const get = (app: FastifyInstance, key: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/emails/0192f0c4-0000-7000-8000-999999999999',
      headers: { authorization: `Bearer ${key}` },
    });

  it('accepts a new key and rejects it once revoked, without restarting', async () => {
    const app = startApp();
    const { key, keyId } = await admin.createKey('crm');

    expect((await get(app, key)).statusCode).toBe(404);

    await admin.revokeKey('crm', keyId);
    expect((await get(app, key)).statusCode).toBe(401);
  });

  it('stores and enqueues an SMTP message and answers 422 for api without a provider', async () => {
    const app = startApp();
    const { key } = await admin.createKey('crm');
    const post = (body: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { authorization: `Bearer ${key}` },
        payload: body as Record<string, unknown>,
      });
    const request = smtpRequest();
    if (request.transport.type === 'smtp') request.transport.smtp.host = 'localhost';

    const accepted = await post(request);
    const withoutProvider = await post(apiRequest());

    expect(accepted.statusCode).toBe(202);
    const { id } = accepted.json<{ id: string }>();
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.smtpConfigEncrypted).toMatch(/^[0-9a-f]{8}:/);
    expect(JSON.stringify(row)).not.toContain('not-a-real-password');
    expect(await redis.exists(`bull:emails-smtp:${id}`)).toBe(1);
    expect(withoutProvider.statusCode).toBe(422);
  });

  it('shares the rate limit of a client across API instances through Redis', async () => {
    await admin.updateClient('crm', { rateLimitPerMinute: 2 });
    const { key } = await admin.createKey('crm');
    const first = startApp();
    const second = startApp();

    expect((await get(first, key)).statusCode).toBe(404);
    expect((await get(second, key)).statusCode).toBe(404);
    expect((await get(first, key)).statusCode).toBe(429);
  });
});
