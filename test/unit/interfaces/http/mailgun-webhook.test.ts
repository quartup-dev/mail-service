import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageFrom } from '../../../support/email-messages';
import { apiRequest } from '../../../support/email-requests';
import { buildTestApp, type TestAppOptions } from '../../../support/http';
import { signedMailgunWebhook } from '../../../support/webhooks';

describe('POST /v1/webhooks/mailgun', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function setup(options: TestAppOptions = {}) {
    const built = buildTestApp(options);
    app = built.app;
    const message = messageFrom(
      apiRequest({ to: [{ email: 'a@dominio.com' }, { email: 'b@dominio.com' }] }),
    );
    await built.emails.create({
      message,
      clientId: 'billing',
      requestId: 'req-1',
      requestHash: 'hash',
    });
    const post = (payload: object) =>
      built.app.inject({ method: 'POST', url: '/v1/webhooks/mailgun', payload });
    const statusesOf = async () =>
      Object.fromEntries(
        ((await built.emails.findById(message.id))?.recipients ?? []).map((r) => [
          r.email,
          r.status,
        ]),
      );
    return { ...built, emailId: message.id, post, statusesOf };
  }

  it('processes a signed event and answers 204', async () => {
    const { post, clock, emailId, statusesOf } = await setup();

    const response = await post(
      signedMailgunWebhook(clock, {
        recipient: 'a@dominio.com',
        'user-variables': { messageId: emailId },
      }),
    );

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(await statusesOf()).toEqual({
      'a@dominio.com': 'delivered',
      'b@dominio.com': 'pending',
    });
  });

  it('keeps each recipient with its own status: one delivered and one bounced', async () => {
    const { post, clock, emailId, statusesOf, suppressions } = await setup();
    const userVariables = { messageId: emailId };

    await post(
      signedMailgunWebhook(clock, { recipient: 'a@dominio.com', 'user-variables': userVariables }),
    );
    await post(
      signedMailgunWebhook(clock, {
        event: 'failed',
        severity: 'permanent',
        recipient: 'b@dominio.com',
        'user-variables': userVariables,
      }),
    );

    expect(await statusesOf()).toEqual({
      'a@dominio.com': 'delivered',
      'b@dominio.com': 'bounced',
    });
    expect(await suppressions.findSuppressed(['a@dominio.com', 'b@dominio.com'])).toEqual(
      new Set(['b@dominio.com']),
    );
  });

  it('answers 204 to a repeated token without processing it again', async () => {
    const { post, clock, emailId, emails } = await setup();
    const body = signedMailgunWebhook(clock, {
      recipient: 'a@dominio.com',
      'user-variables': { messageId: emailId },
    });
    await post(body);

    const repeated = await post(body);

    expect(repeated.statusCode).toBe(204);
    expect(emails.listEvents()).toHaveLength(1);
  });

  it('answers 500 when processing fails and lets the retry be processed', async () => {
    const { post, clock, emailId, emails, statusesOf } = await setup();
    const body = signedMailgunWebhook(clock, {
      recipient: 'a@dominio.com',
      'user-variables': { messageId: emailId },
    });
    vi.spyOn(emails, 'recordEvent').mockRejectedValueOnce(new Error('database down'));

    const failed = await post(body);
    const retried = await post(body);

    expect([failed.statusCode, retried.statusCode]).toEqual([500, 204]);
    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'delivered' });
  });

  it('answers 204 to an event it does not follow without recording it', async () => {
    const { post, clock, emailId, emails } = await setup();

    const response = await post(
      signedMailgunWebhook(clock, {
        event: 'opened',
        recipient: 'a@dominio.com',
        'user-variables': { messageId: emailId },
      }),
    );

    expect(response.statusCode).toBe(204);
    expect(emails.listEvents()).toEqual([]);
  });

  type SignedBody = ReturnType<typeof signedMailgunWebhook>;
  const forged = (body: SignedBody) => ({
    ...body,
    signature: { ...body.signature, signature: 'f'.repeat(64) },
  });
  const untouched = (body: SignedBody) => body;

  it.each([
    ['an invalid signature', forged, {}],
    ['an expired timestamp', untouched, { timestamp: '1700000000' }],
  ])('answers 401 to %s without processing it', async (_case, tamper, signature) => {
    const { post, clock, emailId, emails, statusesOf } = await setup();

    const response = await post(
      tamper(
        signedMailgunWebhook(
          clock,
          { recipient: 'a@dominio.com', 'user-variables': { messageId: emailId } },
          signature,
        ),
      ),
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' },
    });
    expect(emails.listEvents()).toEqual([]);
    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'pending' });
  });

  it.each([
    [
      'without signature',
      (body: ReturnType<typeof signedMailgunWebhook>) => ({ 'event-data': body['event-data'] }),
    ],
    [
      'without event-data',
      (body: ReturnType<typeof signedMailgunWebhook>) => ({ signature: body.signature }),
    ],
  ])('answers 400 to a body %s', async (_case, strip) => {
    const { post, clock } = await setup();

    const response = await post(strip(signedMailgunWebhook(clock, { recipient: 'a@dominio.com' })));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('answers 413 to a body larger than 1 MiB even if the API accepts larger bodies', async () => {
    const { post, clock } = await setup({ limits: { maxBodyBytes: 15_728_640 } });
    const body = signedMailgunWebhook(clock, {
      recipient: 'a@dominio.com',
      'user-variables': { padding: 'x'.repeat(1_048_576) },
    });

    const response = await post(body);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('needs neither an API key nor the per-client rate limit', async () => {
    const { post, clock } = await setup({ limits: { rateLimitDefaultPerMinute: 1 } });

    const responses = await Promise.all(
      [1, 2, 3].map(() => post(signedMailgunWebhook(clock, { recipient: 'a@dominio.com' }))),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204, 204]);
  });

  it('does not exist when the API provider is not Mailgun', async () => {
    const { post, clock } = await setup({ apiProviderName: 'ses' });

    const response = await post(signedMailgunWebhook(clock, { recipient: 'a@dominio.com' }));

    expect(response.statusCode).toBe(404);
  });
});
