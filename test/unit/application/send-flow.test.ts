import { describe, expect, it } from 'vitest';
import { HandleProviderEvent } from '../../../src/application/handle-provider-event';
import { ProcessEmailJob } from '../../../src/application/process-email-job';
import { QueueEmail } from '../../../src/application/queue-email';
import type { EmailRequest } from '../../../src/domain/email';
import { AesGcmSecretBox } from '../../../src/infrastructure/crypto/aes-gcm-secret-box';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { InMemorySuppressionRepository } from '../../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { runSuppressionsCli } from '../../../src/interfaces/cli/suppressions-cli';
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
  const suppressions = new InMemorySuppressionRepository(clock);

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
    suppressions,
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

  // Lo que hacen los webhooks con un evento y el CLI con sus argumentos
  const handleProviderEvent = new HandleProviderEvent({ emails, suppressions, clock });
  const suppressionsCli = (...argv: string[]) =>
    runSuppressionsCli(argv, suppressions, { out: () => {}, err: () => {} });

  return { send, apiProvider, smtpSender, handleProviderEvent, suppressionsCli, clock };
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

  describe('suppression', () => {
    const toA = { to: [{ email: 'a@dominio.com' }] };

    async function sendAndBounce() {
      const flow = setup();
      const first = await flow.send(apiRequest(toA));
      await flow.handleProviderEvent.execute({
        provider: 'mailgun',
        type: 'bounced',
        recipient: 'a@dominio.com',
        occurredAt: flow.clock.now(),
        messageId: first?.id,
        raw: {},
      });
      return flow;
    }

    it('a permanent bounce blocks later api sends to the recipient, but not smtp sends', async () => {
      const { send, apiProvider, smtpSender } = await sendAndBounce();

      const viaApi = await send(apiRequest(toA));
      const viaSmtp = await send(smtpRequest(toA));

      expect(viaApi).toMatchObject({ status: 'suppressed' });
      expect(apiProvider.sent).toHaveLength(1);
      expect(viaSmtp).toMatchObject({ status: 'sent', provider: 'smtp' });
      expect(smtpSender.sent).toHaveLength(1);
    });

    it('suppressions remove lets the api send again', async () => {
      const { send, apiProvider, suppressionsCli } = await sendAndBounce();

      expect(await suppressionsCli('remove', '--email', 'a@dominio.com')).toBe(0);
      const again = await send(apiRequest(toA));

      expect(again).toMatchObject({ status: 'sent', provider: 'mailgun' });
      expect(apiProvider.sent).toHaveLength(2);
    });
  });
});
