import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../../../../src/infrastructure/logger';
import { buildApp } from '../../../../src/interfaces/http/app';

describe('GET /health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('responds 200 with status ok', async () => {
    app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('logs requests through the injected logger without the authorization header', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    app = buildApp({ logger: createLogger({ level: 'info' }, destination) });

    await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer ms_billing_secret' },
    });

    expect(lines.join('')).toContain('"url":"/health"');
    expect(lines.join('')).not.toContain('ms_billing_secret');
  });
});
