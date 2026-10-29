import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../src/application/ports/api-client-repository';
import { QueueEmail, type QueueEmailDeps } from '../../../src/application/queue-email';
import { EmailRequestRejectedError } from '../../../src/domain/errors';
import { AesGcmSecretBox } from '../../../src/infrastructure/crypto/aes-gcm-secret-box';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { apiRequest, smtpRequest } from '../../support/email-requests';
import { FakeClock } from '../../support/fake-clock';
import { FakeEmailQueue } from '../../support/fake-email-queue';
import { FakeLogger } from '../../support/fake-logger';
import { FakeSmtpHostGuard } from '../../support/fake-smtp-host-guard';
import { SequentialIds } from '../../support/sequential-ids';

const client = (overrides: Partial<ApiClient> = {}): ApiClient => ({
  id: 'billing',
  name: 'Facturación',
  allowedTransports: ['smtp', 'api'],
  ...overrides,
});

type QueueEmailSettings = Pick<QueueEmailDeps, 'apiProviderName' | 'allowedFromDomains'>;

function setup(overrides: Partial<QueueEmailSettings> = {}) {
  const clock = new FakeClock();
  const deps = {
    emails: new InMemoryEmailRepository(clock),
    queue: new FakeEmailQueue(),
    smtpHostGuard: new FakeSmtpHostGuard(),
    secretBox: new AesGcmSecretBox({ active: Buffer.alloc(32, 1) }),
    ids: new SequentialIds(),
    logger: new FakeLogger(),
    apiProviderName: 'mailgun' as const,
    allowedFromDomains: ['example.com'],
    requestHashPepper: Buffer.alloc(32, 3),
    ...overrides,
  };
  return { ...deps, useCase: new QueueEmail(deps) };
}

async function rejectionCodeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof EmailRequestRejectedError)) {
    throw new Error(`expected an EmailRequestRejectedError, got ${String(error)}`);
  }
  return error.code;
}

describe('QueueEmail', () => {
  it('stores an api message as queued and enqueues it in the api queue', async () => {
    const { useCase, queue, emails } = setup();

    const { email, created } = await useCase.execute({
      client: client(),
      request: apiRequest(),
      requestId: 'req-1',
    });

    expect(created).toBe(true);
    expect(email).toMatchObject({ status: 'queued', transport: 'api', clientId: 'billing' });
    expect(await emails.findById(email.id)).toEqual(email);
    expect(queue.jobs).toEqual(new Map([[email.id, 'api']]));
  });

  describe('policy', () => {
    it('rejects a transport the client is not allowed to use, without storing it', async () => {
      const { useCase, queue } = setup();

      const code = await rejectionCodeOf(
        useCase.execute({
          client: client({ allowedTransports: ['smtp'] }),
          request: apiRequest(),
          requestId: 'req-1',
        }),
      );

      expect(code).toBe('TRANSPORT_NOT_ALLOWED');
      expect(queue.enqueueCalls).toBe(0);
    });

    it('rejects the api transport when no provider is configured', async () => {
      const { useCase } = setup({ apiProviderName: null });

      const code = await rejectionCodeOf(
        useCase.execute({ client: client(), request: apiRequest(), requestId: 'req-1' }),
      );

      expect(code).toBe('API_TRANSPORT_NOT_CONFIGURED');
    });

    it.each([
      ['the global list', undefined, 'notificaciones@otro.com'],
      ["the client's list", ['*.cliente.com'], 'notificaciones@cliente.com'],
      ["the client's list over the global one", ['cliente.com'], 'notificaciones@example.com'],
    ])('rejects a from domain outside %s', async (_list, clientDomains, from) => {
      const { useCase } = setup({ allowedFromDomains: ['example.com'] });

      const code = await rejectionCodeOf(
        useCase.execute({
          client: client(clientDomains ? { allowedFromDomains: clientDomains } : {}),
          request: apiRequest({ from: { email: from } }),
          requestId: 'req-1',
        }),
      );

      expect(code).toBe('FROM_DOMAIN_NOT_ALLOWED');
    });

    it("accepts a from domain matching the client's wildcard pattern", async () => {
      const { useCase } = setup({ allowedFromDomains: [] });

      const { created } = await useCase.execute({
        client: client({ allowedFromDomains: ['*.cliente.com'] }),
        request: apiRequest({ from: { email: 'avisos@Mail.Cliente.com' } }),
        requestId: 'req-1',
      });

      expect(created).toBe(true);
    });
  });

  describe('smtp transport', () => {
    it('rejects a host the guard does not allow, without storing it', async () => {
      const { useCase, smtpHostGuard, queue } = setup();
      smtpHostGuard.block('smtp.example.com');

      const code = await rejectionCodeOf(
        useCase.execute({ client: client(), request: smtpRequest(), requestId: 'req-1' }),
      );

      expect(code).toBe('SMTP_HOST_NOT_ALLOWED');
      expect(smtpHostGuard.calls).toEqual([{ host: 'smtp.example.com', port: 587 }]);
      expect(queue.enqueueCalls).toBe(0);
    });

    it('stores the configuration encrypted and the payload without password or DKIM key', async () => {
      const { useCase, secretBox, queue } = setup();
      const request = smtpRequest();

      const { email } = await useCase.execute({ client: client(), request, requestId: 'req-1' });

      if (request.transport.type !== 'smtp') throw new Error('expected an SMTP request');
      expect(JSON.parse(secretBox.decrypt(email.smtpConfigEncrypted ?? ''))).toEqual(
        request.transport.smtp,
      );
      expect(email.payload?.transport).toEqual({
        type: 'smtp',
        smtp: { host: 'smtp.example.com', port: 587 },
      });
      expect(JSON.stringify(email)).not.toContain('not-a-real-password');
      expect(JSON.stringify(email)).not.toContain('not-a-real-key');
      expect(queue.jobs).toEqual(new Map([[email.id, 'smtp']]));
    });

    it('does not validate the from domain', async () => {
      const { useCase } = setup({ allowedFromDomains: ['example.com'] });

      const { created } = await useCase.execute({
        client: client(),
        request: smtpRequest({ from: { email: 'avisos@otro.com' } }),
        requestId: 'req-1',
      });

      expect(created).toBe(true);
    });
  });

  it('returns the message as queued and logs a warning when enqueueing fails', async () => {
    const { useCase, queue, logger, emails } = setup();
    queue.failWith(new Error('Redis unavailable'));

    const { email, created } = await useCase.execute({
      client: client(),
      request: apiRequest(),
      requestId: 'req-1',
    });

    expect(created).toBe(true);
    expect((await emails.findById(email.id))?.status).toBe('queued');
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({ level: 'warn', bindings: { messageId: email.id } });
  });

  describe('idempotency', () => {
    const send = (useCase: QueueEmail, request = apiRequest()) =>
      useCase.execute({ client: client(), request, requestId: 'req-1', idempotencyKey: 'key-1' });

    it('returns the existing message and enqueues it again while it is pending', async () => {
      const { useCase, queue } = setup();
      const first = await send(useCase);
      queue.take(first.email.id);

      const second = await send(useCase);

      expect(second).toEqual({ email: first.email, created: false });
      expect(queue.jobs).toEqual(new Map([[first.email.id, 'api']]));
    });

    it('does not enqueue an existing message that is already final', async () => {
      const { useCase, queue, emails } = setup();
      const first = await send(useCase);
      await emails.updateStatus(first.email.id, 'sent');
      const callsBefore = queue.enqueueCalls;

      const second = await send(useCase);

      expect(second.created).toBe(false);
      expect(second.email.status).toBe('sent');
      expect(queue.enqueueCalls).toBe(callsBefore);
    });

    it('does not report a conflict for the same SMTP body although the ciphertext changes', async () => {
      const { useCase } = setup();
      const first = await send(useCase, smtpRequest());

      const second = await send(useCase, smtpRequest());

      expect(second).toEqual({ email: first.email, created: false });
    });

    it('rejects the same key with a different body', async () => {
      const { useCase } = setup();
      await send(useCase, apiRequest({ subject: 'Bienvenido' }));

      const code = await rejectionCodeOf(send(useCase, apiRequest({ subject: 'Otro asunto' })));

      expect(code).toBe('IDEMPOTENCY_CONFLICT');
    });
  });
});
