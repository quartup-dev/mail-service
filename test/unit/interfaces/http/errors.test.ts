import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../../../support/http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request id and error format', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('generates a UUID request id and returns it in X-Request-Id', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-request-id']).toMatch(UUID);
  });

  it('accepts a well-formed incoming X-Request-Id', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'billing-7f3a9c21' },
    });

    expect(response.headers['x-request-id']).toBe('billing-7f3a9c21');
  });

  it.each(['with spaces', 'x'.repeat(129), 'short'])(
    'replaces the malformed incoming X-Request-Id %j',
    async (incoming) => {
      ({ app } = buildTestApp());

      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': incoming },
      });

      expect(response.headers['x-request-id']).toMatch(UUID);
    },
  );

  it('answers an unknown route with 404 in the error format', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({ method: 'GET', url: '/v1/nothing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /v1/nothing not found',
        details: [],
        requestId: response.headers['x-request-id'],
      },
    });
  });

  it('answers an unexpected error with 500 without internal details and logs it', async () => {
    const built = buildTestApp();
    app = built.app;
    app.get('/boom', async () => {
      throw new Error('connection string postgres://secret');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
        requestId: response.headers['x-request-id'],
      },
    });
    expect(built.logs()).toContain('connection string postgres://secret');
    expect(built.logs()).toContain(String(response.headers['x-request-id']));
  });
});
