import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../../support/http';

describe('health routes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('GET /health responds 200 with status ok', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('logs requests through the injected logger without the authorization header', async () => {
    const built = buildTestApp();
    app = built.app;

    await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer ms_billing_secret' },
    });

    expect(built.logs()).toContain('"url":"/health"');
    expect(built.logs()).not.toContain('ms_billing_secret');
  });

  it('GET /ready responds 200 with the state of each dependency', async () => {
    ({ app } = buildTestApp({ readiness: { apiProvider: async () => {} } }));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { postgres: 'ok', redis: 'ok', apiProvider: 'ok' },
    });
  });

  it('GET /ready reports the api provider as not configured when there is none', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ checks: { apiProvider: 'not_configured' } });
  });

  it.each(['postgres', 'redis', 'apiProvider'] as const)(
    'GET /ready responds 503 when %s fails',
    async (failing) => {
      ({ app } = buildTestApp({
        readiness: {
          apiProvider: async () => {},
          [failing]: () => Promise.reject(new Error('down')),
        },
      }));

      const response = await app.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: 'not_ready',
        checks: { [failing]: 'error' },
      });
    },
  );
});
