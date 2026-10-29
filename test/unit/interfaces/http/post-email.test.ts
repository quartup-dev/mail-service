import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { apiRequest, smtpRequest } from '../../../support/email-requests';
import {
  auth,
  BILLING_KEY,
  buildTestApp,
  CRM_KEY,
  type TestAppOptions,
} from '../../../support/http';

type Body = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SMTP_PASSWORD = 'not-a-real-password';

const smtpBody = (overrides: Body = {}): Body => ({ ...smtpRequest(), ...overrides });
const apiBody = (overrides: Body = {}): Body => ({ ...apiRequest(), ...overrides });

const errorOf = (response: LightMyRequestResponse) =>
  response.json<{ error: { code: string; details: Array<{ path: string; code: string }> } }>()
    .error;

describe('POST /v1/emails', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  function setup(options: TestAppOptions = {}) {
    const built = buildTestApp(options);
    app = built.app;
    const post = (body: unknown, key = CRM_KEY, headers: Record<string, string> = {}) =>
      built.app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { ...auth(key), ...headers },
        payload: body as Body,
      });
    return { ...built, post };
  }

  it.each([
    ['api', BILLING_KEY, apiBody()],
    ['smtp', CRM_KEY, smtpBody()],
  ])('accepts a %s message with 202', async (transport, key, body) => {
    const { post, queue } = setup();

    const response = await post(body, key);

    expect(response.statusCode).toBe(202);
    const accepted = response.json<{ id: string }>();
    expect(accepted).toEqual({
      id: expect.stringMatching(UUID) as unknown,
      status: 'queued',
      transport,
    });
    expect(queue.jobs.get(accepted.id)).toBe(transport);
  });

  it('responds 401 without a valid API key', async () => {
    const { app } = setup();

    const response = await app.inject({ method: 'POST', url: '/v1/emails', payload: apiBody() });

    expect(response.statusCode).toBe(401);
  });

  describe('validation', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ email: `r${index}@dominio.com` }));

    it.each<[string, Body, string]>([
      ['an invalid email', apiBody({ to: [{ email: 'not-an-email' }] }), '/to/0/email'],
      ['no recipient in to', apiBody({ to: [] }), '/to'],
      [
        'a recipient repeated in to and cc',
        apiBody({ to: [{ email: 'a@dominio.com' }], cc: [{ email: 'A@Dominio.com' }] }),
        '/cc/0/email',
      ],
      ['an empty subject', apiBody({ subject: '' }), '/subject'],
      ['neither text nor html', apiBody({ text: undefined }), '/text'],
      ['more than 50 recipients', apiBody({ to: many(30), cc: many(51).slice(30) }), '/to'],
      ['a line break in the subject', apiBody({ subject: 'Hola\r\nBcc: x@y.com' }), '/subject'],
      [
        'a line break in a name',
        apiBody({ from: { email: 'a@example.com', name: 'A\nB' } }),
        '/from/name',
      ],
      [
        'a line break in a header',
        apiBody({ headers: { 'X-Custom': 'a\r\nb' } }),
        '/headers/X-Custom',
      ],
      ['a reserved header', apiBody({ headers: { Subject: 'Otro' } }), '/headers/Subject'],
      ['a reserved header in lowercase', apiBody({ headers: { bcc: 'x@y.com' } }), '/headers/bcc'],
      ['smtp without the smtp object', apiBody({ transport: { type: 'smtp' } }), '/transport/smtp'],
      [
        'an SMTP port other than 465 or 587',
        smtpBody({ transport: { type: 'smtp', smtp: { host: 'smtp.example.com', port: 25 } } }),
        '/transport/smtp/port',
      ],
      [
        'a secure field',
        smtpBody({
          transport: { type: 'smtp', smtp: { host: 'smtp.example.com', port: 465, secure: true } },
        }),
        '/transport/smtp',
      ],
      [
        'api with an smtp object',
        apiBody({ transport: { type: 'api', smtp: { host: 'smtp.example.com', port: 587 } } }),
        '/transport',
      ],
    ])('responds 400 for %s', async (_case, body, path) => {
      const { post } = setup();

      const response = await post(body);

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
      expect(errorOf(response).details.map((detail) => detail.path)).toContain(path);
    });

    it('responds 400 when the decoded attachments exceed the limit', async () => {
      const { post } = setup({ limits: { maxAttachmentsBytes: 1_000 } });
      const attachment = (bytes: number) => ({
        filename: 'a.bin',
        contentType: 'application/octet-stream',
        contentBase64: Buffer.alloc(bytes).toString('base64'),
      });

      const within = await post(apiBody({ attachments: [attachment(500), attachment(500)] }));
      const over = await post(apiBody({ attachments: [attachment(500), attachment(501)] }));

      expect(within.statusCode).toBe(202);
      expect(over.statusCode).toBe(400);
      expect(errorOf(over).details).toEqual([
        expect.objectContaining({ path: '/attachments', code: 'too_big' }) as unknown,
      ]);
    });

    it('responds 400 for an Idempotency-Key longer than 255 characters', async () => {
      const { post } = setup();

      const response = await post(apiBody(), CRM_KEY, { 'idempotency-key': 'k'.repeat(256) });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).details.map((detail) => detail.path)).toContain('/idempotency-key');
    });

    it('responds 400 for a body that is not valid JSON', async () => {
      const { app } = setup();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/emails',
        headers: { ...auth(CRM_KEY), 'content-type': 'application/json' },
        payload: '{"transport":',
      });

      expect(response.statusCode).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    });

    it('responds 413 for a body larger than the limit', async () => {
      const { post } = setup({ limits: { maxBodyBytes: 2_000 } });

      const response = await post(apiBody({ text: 'x'.repeat(3_000) }));

      expect(response.statusCode).toBe(413);
      expect(errorOf(response).code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('policy', () => {
    it.each<[string, TestAppOptions, string, Body, number, string]>([
      [
        'a transport the client cannot use',
        {},
        BILLING_KEY,
        smtpBody(),
        403,
        'TRANSPORT_NOT_ALLOWED',
      ],
      [
        'a from domain the client cannot use',
        {},
        BILLING_KEY,
        apiBody({ from: { email: 'avisos@otro.com' } }),
        403,
        'FROM_DOMAIN_NOT_ALLOWED',
      ],
      [
        'api without a provider',
        { apiProviderName: null },
        CRM_KEY,
        apiBody(),
        422,
        'API_TRANSPORT_NOT_CONFIGURED',
      ],
    ])('rejects %s', async (_case, options, key, body, status, code) => {
      const { post } = setup(options);

      const response = await post(body, key);

      expect(response.statusCode).toBe(status);
      expect(errorOf(response).code).toBe(code);
    });

    it('responds 422 for an SMTP host the guard does not allow', async () => {
      const { post, smtpHostGuard } = setup();
      smtpHostGuard.block('smtp.example.com');

      const response = await post(smtpBody());

      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe('SMTP_HOST_NOT_ALLOWED');
    });
  });

  describe('idempotency', () => {
    it('returns the existing message with 200 for the same key and body', async () => {
      const { post } = setup();
      const first = await post(smtpBody(), CRM_KEY, { 'idempotency-key': 'key-1' });

      const second = await post(smtpBody(), CRM_KEY, { 'idempotency-key': 'key-1' });

      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
    });

    it('responds 409 for the same key with another body', async () => {
      const { post } = setup();
      await post(apiBody(), CRM_KEY, { 'idempotency-key': 'key-1' });

      const second = await post(apiBody({ subject: 'Otro' }), CRM_KEY, {
        'idempotency-key': 'key-1',
      });

      expect(second.statusCode).toBe(409);
      expect(errorOf(second).code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  it('never returns or logs the SMTP password', async () => {
    const { post, smtpHostGuard, logs } = setup();
    const responses = [
      await post(smtpBody(), CRM_KEY, { 'idempotency-key': 'key-1' }),
      await post(smtpBody(), CRM_KEY, { 'idempotency-key': 'key-1' }),
      await post(smtpBody({ subject: '' })),
    ];
    smtpHostGuard.block('smtp.example.com');
    responses.push(await post(smtpBody()));

    for (const response of responses) expect(response.body).not.toContain(SMTP_PASSWORD);
    expect(logs()).not.toContain(SMTP_PASSWORD);
  });
});
