import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../src/application/ports/api-client-repository';
import { QueueEmail, type QueueEmailDeps } from '../../../src/application/queue-email';
import { EmailRequestRejectedError } from '../../../src/domain/errors';
import { AesGcmSecretBox } from '../../../src/infrastructure/crypto/aes-gcm-secret-box';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { apiRequest } from '../../support/email-requests';
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

function setup(overrides: Partial<QueueEmailDeps> = {}) {
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
});
