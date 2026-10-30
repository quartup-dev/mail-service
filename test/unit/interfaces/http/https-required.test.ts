import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRequest } from '../../../support/email-requests';
import { auth, buildTestApp, CRM_KEY, type TestAppOptions } from '../../../support/http';

const PROXY_IP = '10.0.0.5';

describe('HTTPS on /v1/emails', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  // Por defecto, como en producción: HTTPS obligatorio y el proxy de confianza en PROXY_IP
  function setup(options: TestAppOptions = {}) {
    const built = buildTestApp({ requireHttps: true, trustProxy: [PROXY_IP], ...options });
    app = built.app;
    return built;
  }

  it('answers 403 HTTPS_REQUIRED to a POST over HTTP in production, without creating it', async () => {
    const { app, emails, queue } = setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      remoteAddress: PROXY_IP,
      headers: { ...auth(CRM_KEY), 'x-forwarded-proto': 'http' },
      payload: apiRequest(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'HTTPS_REQUIRED', message: 'HTTPS is required' },
    });
    expect(await emails.findPending({}, 10)).toEqual([]);
    expect(queue.jobs.size).toBe(0);
  });

  const viaProxy = (protocol: string, remoteAddress = PROXY_IP) => ({
    remoteAddress,
    headers: { ...auth(CRM_KEY), 'x-forwarded-proto': protocol, 'x-forwarded-for': '198.51.100.7' },
  });

  it('answers 403 HTTPS_REQUIRED to a GET over HTTP in production', async () => {
    const { app } = setup();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/emails/0192f0c4-0000-7000-8000-999999999999',
      ...viaProxy('http'),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'HTTPS_REQUIRED' } });
  });

  it('serves a request that reached the trusted proxy over HTTPS', async () => {
    const { app } = setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      ...viaProxy('https'),
      payload: apiRequest(),
    });

    expect(response.statusCode).toBe(202);
  });

  it('does not take X-Forwarded-Proto from an address that is not the trusted proxy', async () => {
    const { app } = setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      ...viaProxy('https', '203.0.113.9'),
      payload: apiRequest(),
    });

    expect(response.statusCode).toBe(403);
  });

  it('serves HTTP outside production', async () => {
    const { app } = setup({ requireHttps: false, trustProxy: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: auth(CRM_KEY),
      payload: apiRequest(),
    });

    expect(response.statusCode).toBe(202);
  });

  it.each(['/health', '/ready'])('does not require HTTPS on %s', async (url) => {
    const { app } = setup();

    const response = await app.inject({ method: 'GET', url, remoteAddress: PROXY_IP });

    expect(response.statusCode).toBe(200);
  });

  it('does not require HTTPS on the webhooks, which are authenticated by signature', async () => {
    const { app } = setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/mailgun',
      remoteAddress: PROXY_IP,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('logs the address of the client behind the trusted proxy', async () => {
    const { app, logs } = setup();

    await app.inject({ method: 'GET', url: '/health', ...viaProxy('https') });

    expect(logs()).toContain('"remoteAddress":"198.51.100.7"');
  });
});
