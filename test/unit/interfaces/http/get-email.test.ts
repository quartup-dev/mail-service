import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { messageFrom } from '../../../support/email-messages';
import { smtpRequest } from '../../../support/email-requests';
import { auth, BILLING_KEY, buildTestApp, CRM_KEY } from '../../../support/http';

const UNKNOWN_ID = '0192f0c4-0000-7000-8000-999999999999';

describe('GET /v1/emails/:id', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function setupWithSentSmtpEmail() {
    const built = buildTestApp();
    app = built.app;
    const { emails, clock } = built;
    const message = messageFrom(
      smtpRequest({ to: [{ email: 'a@dominio.com' }], cc: [{ email: 'b@dominio.com' }] }),
    );
    if (message.transport.type === 'smtp') {
      message.transport = { type: 'smtp', smtp: { host: 'smtp.example.com', port: 587 } };
    }
    await emails.create({
      message,
      clientId: 'crm',
      requestId: 'req-1',
      requestHash: 'hash',
      smtpConfigEncrypted: 'key-id:encrypted-config',
    });
    clock.advance(1_000);
    await emails.recordAttempt(message.id, {
      attempt: 1,
      transport: 'smtp',
      provider: 'smtp',
      outcome: 'success',
      code: null,
      message: null,
      durationMs: 120,
      createdAt: clock.now(),
    });
    await emails.updateStatus(message.id, 'sent', {
      provider: 'smtp',
      providerMessageId: '<abc@smtp.example.com>',
      sentAt: clock.now(),
    });
    await emails.setRecipientStatuses(message.id, [
      { email: 'a@dominio.com', status: 'accepted' },
      { email: 'b@dominio.com', status: 'rejected' },
    ]);
    return { app: built.app, id: message.id, clock };
  }

  it.each([
    ['no authorization header', {}],
    ['another scheme', { authorization: `Basic ${CRM_KEY}` }],
    ['an unknown key', auth('ms_crm_wrong-secret')],
    ['a malformed key', auth('not-a-key')],
  ])('responds 401 with %s', async (_case, headers) => {
    ({ app } = buildTestApp());

    const response = await app.inject({ method: 'GET', url: `/v1/emails/${UNKNOWN_ID}`, headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API key', details: [] },
    });
  });

  it('returns the status of a message of the client without SMTP credentials', async () => {
    const { app, id } = await setupWithSentSmtpEmail();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/emails/${id}`,
      headers: auth(CRM_KEY),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id,
      status: 'sent',
      transport: 'smtp',
      provider: 'smtp',
      providerMessageId: '<abc@smtp.example.com>',
      smtp: { host: 'smtp.example.com', port: 587 },
      errorCode: null,
      errorMessage: null,
      recipients: [
        {
          email: 'a@dominio.com',
          kind: 'to',
          status: 'accepted',
          updatedAt: '2026-10-29T10:00:01.000Z',
        },
        {
          email: 'b@dominio.com',
          kind: 'cc',
          status: 'rejected',
          updatedAt: '2026-10-29T10:00:01.000Z',
        },
      ],
      deliverySummary: { accepted: 1, rejected: 1 },
      attempts: [
        {
          attempt: 1,
          transport: 'smtp',
          provider: 'smtp',
          outcome: 'success',
          code: null,
          message: null,
          durationMs: 120,
          createdAt: '2026-10-29T10:00:01.000Z',
        },
      ],
      createdAt: '2026-10-29T10:00:00.000Z',
      updatedAt: '2026-10-29T10:00:01.000Z',
      sentAt: '2026-10-29T10:00:01.000Z',
    });
    expect(response.body).not.toContain('encrypted-config');
  });

  it('logs authenticated requests with the client id', async () => {
    const built = buildTestApp();
    app = built.app;

    await app.inject({ method: 'GET', url: `/v1/emails/${UNKNOWN_ID}`, headers: auth(CRM_KEY) });

    const completed = built
      .logs()
      .split('\n')
      .find((line) => line.includes('request completed'));
    expect(completed).toContain('"clientId":"crm"');
  });

  it("responds 404 for another client's message", async () => {
    const { app, id } = await setupWithSentSmtpEmail();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/emails/${id}`,
      headers: auth(BILLING_KEY),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Email not found' },
    });
  });

  it('responds 404 for an unknown message', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({
      method: 'GET',
      url: `/v1/emails/${UNKNOWN_ID}`,
      headers: auth(CRM_KEY),
    });

    expect(response.statusCode).toBe(404);
  });

  it('responds 400 for an id that is not a UUID', async () => {
    ({ app } = buildTestApp());

    const response = await app.inject({
      method: 'GET',
      url: '/v1/emails/123',
      headers: auth(CRM_KEY),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: '/id', code: 'invalid_format' }] },
    });
  });
});
