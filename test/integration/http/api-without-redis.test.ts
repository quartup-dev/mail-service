import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleApiClientAdmin } from '../../../src/infrastructure/auth/drizzle-api-client-admin';
import { loadConfig } from '../../../src/infrastructure/config';
import { createApiContainer } from '../../../src/infrastructure/container';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { emails } from '../../../src/infrastructure/db/schema';
import { createLogger } from '../../../src/infrastructure/logger';
import { SystemClock } from '../../../src/infrastructure/system-clock';
import { smtpRequest } from '../../support/email-requests';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const PEPPER = Buffer.alloc(32, 3).toString('base64');

// Un puerto donde no escucha nadie: Redis no está disponible
const config = loadConfig('api', {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: 'redis://127.0.0.1:1',
  SMTP_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  API_KEY_PEPPER: PEPPER,
  SMTP_ALLOWED_PRIVATE_HOSTS: 'localhost',
});

const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describe('API without Redis', () => {
  let key: string;

  beforeEach(async () => {
    await resetTables(db, { seedClients: false });
    const admin = new DrizzleApiClientAdmin(db, Buffer.from(PEPPER, 'base64'), new SystemClock());
    await admin.createClient('crm', {
      name: 'CRM',
      allowedTransports: ['smtp', 'api'],
      allowedFromDomains: null,
      rateLimitPerMinute: null,
    });
    ({ key } = await admin.createKey('crm'));
  });

  it('keeps serving requests, stores messages for the sweep and reports not ready', async () => {
    const { app } = createApiContainer(config, createLogger({ level: 'silent' }));
    const request = smtpRequest();
    if (request.transport.type === 'smtp') request.transport.smtp.host = 'localhost';

    const started = Date.now();
    const posted = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${key}` },
      payload: request as unknown as Record<string, unknown>,
    });
    const elapsed = Date.now() - started;
    const fetched = await app.inject({
      method: 'GET',
      url: '/v1/emails/0192f0c4-0000-7000-8000-999999999999',
      headers: { authorization: `Bearer ${key}` },
    });
    const ready = await app.inject({ method: 'GET', url: '/ready' });

    expect(posted.statusCode).toBe(202);
    expect(elapsed).toBeLessThan(2_000);
    const { id } = posted.json<{ id: string }>();
    const [row] = await db.select().from(emails).where(eq(emails.id, id));
    expect(row?.status).toBe('queued');
    expect(fetched.statusCode).toBe(404);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ checks: { redis: 'error', postgres: 'ok' } });

    await expect(app.close()).resolves.toBeUndefined();
  });
});
