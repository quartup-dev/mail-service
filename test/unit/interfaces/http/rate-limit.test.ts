import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auth, BILLING_KEY, buildTestApp, CRM_KEY } from '../../../support/http';

const UNKNOWN_ID = '0192f0c4-0000-7000-8000-999999999999';

describe('rate limit of /v1/emails', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  const get = (headers: Record<string, string> = {}) =>
    (app as FastifyInstance).inject({ method: 'GET', url: `/v1/emails/${UNKNOWN_ID}`, headers });

  it("rejects with 429 and Retry-After over the client's own limit", async () => {
    ({ app } = buildTestApp());

    for (let i = 0; i < 3; i++) expect((await get(auth(BILLING_KEY))).statusCode).toBe(404);
    const limited = await get(auth(BILLING_KEY));

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded, retry in 60 seconds',
        details: [],
        requestId: limited.headers['x-request-id'],
      },
    });
  });

  it('applies the default limit to a client without its own', async () => {
    ({ app } = buildTestApp({ limits: { rateLimitDefaultPerMinute: 2 } }));

    await get(auth(CRM_KEY));
    await get(auth(CRM_KEY));

    expect((await get(auth(CRM_KEY))).statusCode).toBe(429);
  });

  it('counts each client separately', async () => {
    ({ app } = buildTestApp({ limits: { rateLimitDefaultPerMinute: 2 } }));
    for (let i = 0; i < 4; i++) await get(auth(BILLING_KEY));

    expect((await get(auth(CRM_KEY))).statusCode).toBe(404);
  });

  it('does not count requests without a valid API key', async () => {
    ({ app } = buildTestApp());
    for (let i = 0; i < 5; i++) expect((await get(auth('ms_billing_wrong'))).statusCode).toBe(401);

    for (let i = 0; i < 3; i++) expect((await get(auth(BILLING_KEY))).statusCode).toBe(404);
  });
});
