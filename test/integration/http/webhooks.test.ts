import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DrizzleApiClientAdmin } from '../../../src/infrastructure/auth/drizzle-api-client-admin';
import { loadConfig } from '../../../src/infrastructure/config';
import { createApiContainer } from '../../../src/infrastructure/container';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { emailEvents } from '../../../src/infrastructure/db/schema';
import { createLogger } from '../../../src/infrastructure/logger';
import { SystemClock } from '../../../src/infrastructure/system-clock';
import { apiRequest } from '../../support/email-requests';
import { resetTables, TEST_DATABASE_URL, TEST_REDIS_URL } from '../../support/integration';
import { MAILGUN_SIGNING_KEY, signedMailgunWebhook } from '../../support/webhooks';

const PEPPER = Buffer.alloc(32, 3).toString('base64');
const REDIS_DB_URL = `${TEST_REDIS_URL}/15`; // base dedicada: se vacía en cada test

const config = loadConfig('api', {
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: REDIS_DB_URL,
  SMTP_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  API_KEY_PEPPER: PEPPER,
  ALLOWED_FROM_DOMAINS: 'example.com',
  MAIL_API_PROVIDER: 'mailgun',
  MAILGUN_WEBHOOK_SIGNING_KEY: MAILGUN_SIGNING_KEY,
  LOG_LEVEL: 'silent',
});

const { db, pool } = connectDatabase(TEST_DATABASE_URL);
const redis = new Redis(REDIS_DB_URL);

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('Mailgun webhook with PostgreSQL and Redis', () => {
  const apps: FastifyInstance[] = [];
  let key: string;

  beforeEach(async () => {
    await resetTables(db, { seedClients: false });
    await redis.flushdb();
    const admin = new DrizzleApiClientAdmin(db, Buffer.from(PEPPER, 'base64'), new SystemClock());
    await admin.createClient('crm', {
      name: 'CRM',
      allowedTransports: ['api'],
      allowedFromDomains: null,
      rateLimitPerMinute: null,
    });
    ({ key } = await admin.createKey('crm'));
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  function startApp(): FastifyInstance {
    const { app } = createApiContainer(config, createLogger({ level: 'silent' }));
    apps.push(app);
    return app;
  }

  it('advances the recipient and ignores the same token repeated on another instance', async () => {
    const [first, second] = [startApp(), startApp()];
    const created = await first.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${key}` },
      payload: apiRequest({ to: [{ email: 'a@dominio.com' }] }),
    });
    const { id } = created.json<{ id: string }>();
    const webhook = signedMailgunWebhook(new SystemClock(), {
      recipient: 'a@dominio.com',
      'user-variables': { messageId: id },
    });
    const post = (app: FastifyInstance) =>
      app.inject({ method: 'POST', url: '/v1/webhooks/mailgun', payload: webhook });

    const processed = await post(first);
    const repeated = await post(second);

    expect([processed.statusCode, repeated.statusCode]).toEqual([204, 204]);
    const status = await first.inject({
      method: 'GET',
      url: `/v1/emails/${id}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(status.json()).toMatchObject({
      recipients: [{ email: 'a@dominio.com', status: 'delivered' }],
    });
    expect(await db.select().from(emailEvents).where(eq(emailEvents.emailId, id))).toHaveLength(1);
  });

  it('answers 401 to a forged signature', async () => {
    const app = startApp();
    const webhook = signedMailgunWebhook(new SystemClock(), { recipient: 'a@dominio.com' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mailgun',
      payload: { ...webhook, signature: { ...webhook.signature, signature: 'f'.repeat(64) } },
    });

    expect(response.statusCode).toBe(401);
  });
});
