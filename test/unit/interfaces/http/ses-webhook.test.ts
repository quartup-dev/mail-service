import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SnsMessage } from '../../../../src/infrastructure/webhooks/sns-message-verifier';
import { messageFrom } from '../../../support/email-messages';
import { apiRequest } from '../../../support/email-requests';
import { auth, buildTestApp, CRM_KEY, type TestAppOptions } from '../../../support/http';
import { signedSnsMessage, type SnsTestMessage } from '../../../support/webhooks';

describe('POST /v1/webhooks/ses', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  async function setup(options: TestAppOptions = {}) {
    const built = buildTestApp({ apiProviderName: 'ses', ...options });
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
    // SNS envía el JSON con Content-Type: text/plain
    const post = (payload: SnsMessage | string, contentType = 'text/plain; charset=UTF-8') =>
      built.app.inject({
        method: 'POST',
        url: '/v1/webhooks/ses',
        headers: { 'content-type': contentType },
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    const notification = (sesEvent: object, fields: SnsTestMessage = {}) =>
      signedSnsMessage(built.clock, { Message: JSON.stringify(sesEvent), ...fields });
    const mail = { messageId: 'ses-1', tags: { messageId: [message.id] } };
    const statusesOf = async () =>
      Object.fromEntries(
        ((await built.emails.findById(message.id))?.recipients ?? []).map((r) => [
          r.email,
          r.status,
        ]),
      );
    return { ...built, emailId: message.id, post, notification, mail, statusesOf };
  }

  it('processes a signed notification sent as text/plain and answers 204', async () => {
    const { post, notification, mail, statusesOf } = await setup();

    const response = await post(
      notification({
        eventType: 'Delivery',
        mail,
        delivery: { timestamp: '2026-10-29T10:00:01.000Z', recipients: ['a@dominio.com'] },
      }),
    );

    expect(response.statusCode).toBe(204);
    expect(await statusesOf()).toEqual({
      'a@dominio.com': 'delivered',
      'b@dominio.com': 'pending',
    });
  });

  const delivery = (mail: object) => ({
    eventType: 'Delivery',
    mail,
    delivery: { timestamp: '2026-10-29T10:00:01.000Z', recipients: ['a@dominio.com'] },
  });

  it('keeps the text/plain parser inside the webhook: POST /v1/emails still rejects it', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { ...auth(CRM_KEY), 'content-type': 'text/plain' },
      payload: JSON.stringify(apiRequest()),
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['an invalid signature', { Signature: Buffer.from('forged').toString('base64') }],
    ['an unknown SignatureVersion', { SignatureVersion: '3' }],
    ['a SigningCertURL with http', { SigningCertURL: 'http://sns.eu-west-1.amazonaws.com/c.pem' }],
    [
      'a SigningCertURL with amazonaws.com as a substring',
      { SigningCertURL: 'https://sns.eu-west-1.amazonaws.com.evil.example/c.pem' },
    ],
    ['a topic that is not allowed', { TopicArn: 'arn:aws:sns:eu-west-1:999999999999:other' }],
    ['an expired Timestamp', { Timestamp: '2026-10-29T08:00:00.000Z' }],
  ])('answers 401 to %s without processing it', async (_case, fields) => {
    const { post, notification, mail, emails } = await setup();

    const response = await post(notification(delivery(mail), fields));

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(emails.listEvents()).toEqual([]);
  });

  it('answers 204 to a repeated MessageId without processing it again', async () => {
    const { post, notification, mail, emails } = await setup();
    const message = notification(delivery(mail));
    await post(message);

    const repeated = await post(message);

    expect(repeated.statusCode).toBe(204);
    expect(emails.listEvents()).toHaveLength(1);
  });

  it('confirms the subscription of an allowed topic', async () => {
    const { post, clock, confirmedSubscriptions } = await setup();
    const subscribeUrl =
      'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=abc';

    const response = await post(
      signedSnsMessage(clock, {
        Type: 'SubscriptionConfirmation',
        Message: 'You have chosen to subscribe to the topic',
        SubscribeURL: subscribeUrl,
        Token: 'abc',
      }),
    );

    expect(response.statusCode).toBe(204);
    expect(confirmedSubscriptions).toEqual([subscribeUrl]);
  });

  it('answers 204 to an UnsubscribeConfirmation without doing anything', async () => {
    const { post, clock, confirmedSubscriptions, emails } = await setup();

    const response = await post(
      signedSnsMessage(clock, {
        Type: 'UnsubscribeConfirmation',
        Message: 'You have unsubscribed',
        SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=a',
        Token: 'a',
      }),
    );

    expect(response.statusCode).toBe(204);
    expect(confirmedSubscriptions).toEqual([]);
    expect(emails.listEvents()).toEqual([]);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const { post } = await setup();

    const response = await post('not json');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('answers 400 to an unknown message type', async () => {
    const { post, clock } = await setup();

    const response = await post(signedSnsMessage(clock, { Type: 'Unknown' }));

    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['not JSON', 'not json'],
    ['not an SES event', JSON.stringify({ hello: 'world' })],
  ])('answers 400 to a signed notification whose Message is %s', async (_case, message) => {
    const { post, clock } = await setup();

    const response = await post(signedSnsMessage(clock, { Message: message }));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('answers 500 when processing fails and lets the retry be processed', async () => {
    const { post, notification, mail, emails, statusesOf } = await setup();
    const message = notification(delivery(mail));
    vi.spyOn(emails, 'recordEvent').mockRejectedValueOnce(new Error('database down'));

    const failed = await post(message);
    const retried = await post(message);

    expect([failed.statusCode, retried.statusCode]).toEqual([500, 204]);
    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'delivered' });
  });

  it('answers 413 to a body larger than 1 MiB', async () => {
    const { post, notification, mail } = await setup({ limits: { maxBodyBytes: 15_728_640 } });

    const response = await post(
      notification({ ...delivery(mail), padding: 'x'.repeat(1_048_576) }),
    );

    expect(response.statusCode).toBe(413);
  });

  it('does not exist when the API provider is not SES', async () => {
    const { post, notification, mail } = await setup({ apiProviderName: 'mailgun' });

    const response = await post(notification(delivery(mail)));

    expect(response.statusCode).toBe(404);
  });
});
