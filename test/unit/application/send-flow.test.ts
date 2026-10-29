import { describe, expect, it } from 'vitest';
import { ProcessEmailJob } from '../../../src/application/process-email-job';
import { QueueEmail } from '../../../src/application/queue-email';
import type { EmailRequest } from '../../../src/domain/email';
import { AesGcmSecretBox } from '../../../src/infrastructure/crypto/aes-gcm-secret-box';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { InMemorySuppressionRepository } from '../../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { apiRequest, smtpRequest } from '../../support/email-requests';
import { FakeClock } from '../../support/fake-clock';
import { FakeEmailQueue } from '../../support/fake-email-queue';
import { FakeLogger } from '../../support/fake-logger';
import { FakeApiProvider, FakeSmtpSender } from '../../support/fake-senders';
import { FakeSmtpHostGuard } from '../../support/fake-smtp-host-guard';
import { SequentialIds } from '../../support/sequential-ids';

// API y worker comparten repositorio y cola; el worker vacía la cola como lo haría BullMQ
function setup() {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const queue = new FakeEmailQueue();
  const secretBox = new AesGcmSecretBox({ active: Buffer.alloc(32, 1) });
  const smtpHostGuard = new FakeSmtpHostGuard();
  const apiProvider = new FakeApiProvider(clock);
  const smtpSender = new FakeSmtpSender(clock);

  const queueEmail = new QueueEmail({
    emails,
    queue,
    smtpHostGuard,
    secretBox,
    ids: new SequentialIds(),
    logger: new FakeLogger(),
    apiProviderName: apiProvider.name,
    allowedFromDomains: ['example.com'],
    requestHashPepper: Buffer.alloc(32, 3),
  });
  const processEmailJob = new ProcessEmailJob({
    emails,
    suppressions: new InMemorySuppressionRepository(clock),
    apiProvider,
    smtpSender,
    smtpHostGuard,
    secretBox,
    clock,
    logger: new FakeLogger(),
  });

  const send = async (request: EmailRequest) => {
    const { email } = await queueEmail.execute({
      client: { id: 'billing', name: 'Facturación', allowedTransports: ['smtp', 'api'] },
      request,
      requestId: 'req-1',
    });
    for (const messageId of [...queue.jobs.keys()]) {
      queue.take(messageId);
      await processEmailJob.execute({ messageId, attempt: 1, maxAttempts: 5 });
    }
    return emails.findById(email.id);
  };

  return { send, apiProvider, smtpSender };
}

describe('send flow', () => {
  it('queues and sends an api message', async () => {
    const { send, apiProvider } = setup();

    const email = await send(apiRequest());

    expect(email).toMatchObject({ status: 'sent', provider: 'mailgun' });
    expect(apiProvider.sent).toHaveLength(1);
  });

  it('queues and sends an SMTP message, leaving no encrypted configuration behind', async () => {
    const { send, smtpSender } = setup();

    const email = await send(smtpRequest());

    expect(email).toMatchObject({ status: 'sent', provider: 'smtp', smtpConfigEncrypted: null });
    expect(smtpSender.sent[0]?.server.auth?.pass).toBe('not-a-real-password');
  });
});
