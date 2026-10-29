import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../src/application/ports/api-client-repository';
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
import { FakeSmtpHostGuard, VALIDATED_IP } from '../../support/fake-smtp-host-guard';
import { SequentialIds } from '../../support/sequential-ids';

const KEY_A = Buffer.alloc(32, 1);
const MAX_ATTEMPTS = 5;

const CLIENT: ApiClient = { id: 'billing', name: 'Facturación', allowedTransports: ['smtp', 'api'] };

interface SetupOptions {
  withApiProvider?: boolean;
  workerSecretBox?: AesGcmSecretBox;
}

function setup({ withApiProvider = true, workerSecretBox }: SetupOptions = {}) {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const suppressions = new InMemorySuppressionRepository(clock);
  const apiProvider = new FakeApiProvider(clock);
  const smtpSender = new FakeSmtpSender(clock);
  const smtpHostGuard = new FakeSmtpHostGuard();
  const apiSecretBox = new AesGcmSecretBox({ active: KEY_A });

  const queueEmail = new QueueEmail({
    emails,
    queue: new FakeEmailQueue(),
    smtpHostGuard: new FakeSmtpHostGuard(),
    secretBox: apiSecretBox,
    ids: new SequentialIds(),
    logger: new FakeLogger(),
    apiProviderName: 'mailgun',
    allowedFromDomains: ['example.com'],
    requestHashPepper: Buffer.alloc(32, 3),
  });

  const useCase = new ProcessEmailJob({
    emails,
    suppressions,
    apiProvider: withApiProvider ? apiProvider : null,
    smtpSender,
    smtpHostGuard,
    secretBox: workerSecretBox ?? apiSecretBox,
    clock,
  });

  const queue = async (request: EmailRequest = apiRequest()) =>
    (await queueEmail.execute({ client: CLIENT, request, requestId: 'req-1' })).email.id;

  const process = (messageId: string, attempt = 1) =>
    useCase.execute({ messageId, attempt, maxAttempts: MAX_ATTEMPTS });

  return { clock, emails, suppressions, apiProvider, smtpSender, smtpHostGuard, queue, process };
}

describe('ProcessEmailJob', () => {
  it('sends an api message and stores the result', async () => {
    const { queue, process, emails, apiProvider, clock } = setup();
    const id = await queue(apiRequest({ to: [{ email: 'Cliente@Dominio.com' }] }));
    clock.advance(1_000);

    await process(id);

    expect(apiProvider.sent.map((message) => message.id)).toEqual([id]);
    expect(await emails.findById(id)).toMatchObject({
      status: 'sent',
      provider: 'mailgun',
      providerMessageId: 'mailgun-1',
      sentAt: clock.now(),
      recipients: [{ email: 'cliente@dominio.com', status: 'accepted' }],
      attempts: [
        { attempt: 1, transport: 'api', provider: 'mailgun', outcome: 'success', code: null },
      ],
    });
  });

  it('sends an SMTP message to the validated IP with the decrypted configuration', async () => {
    const { queue, process, emails, smtpSender, smtpHostGuard } = setup();
    const request = smtpRequest();
    const id = await queue(request);

    await process(id);

    if (request.transport.type !== 'smtp') throw new Error('expected an SMTP request');
    expect(smtpHostGuard.calls).toEqual([{ host: 'smtp.example.com', port: 587 }]);
    expect(smtpSender.sent).toHaveLength(1);
    expect(smtpSender.sent[0]).toMatchObject({
      message: { id },
      server: request.transport.smtp,
      target: { ip: VALIDATED_IP },
    });
    expect(await emails.findById(id)).toMatchObject({
      status: 'sent',
      provider: 'smtp',
      providerMessageId: '<smtp-1@example.com>',
      smtpConfigEncrypted: null,
      attempts: [{ transport: 'smtp', provider: 'smtp', outcome: 'success' }],
    });
  });

  it('marks the recipients the SMTP server rejected and accepts the rest', async () => {
    const { queue, process, emails, smtpSender } = setup();
    const id = await queue(
      smtpRequest({ to: [{ email: 'ok@dominio.com' }], cc: [{ email: 'Nadie@Dominio.com' }] }),
    );
    smtpSender.rejectRecipients('nadie@dominio.com');

    await process(id);

    expect((await emails.findById(id))?.recipients).toMatchObject([
      { email: 'ok@dominio.com', status: 'accepted' },
      { email: 'nadie@dominio.com', status: 'rejected' },
    ]);
  });

  it.each(['sent', 'failed', 'suppressed'] as const)(
    'does not send a message that is already %s',
    async (status) => {
      const { queue, process, emails, apiProvider } = setup();
      const id = await queue();
      await emails.updateStatus(id, status);

      await process(id);

      expect(apiProvider.sent).toEqual([]);
      expect((await emails.findById(id))?.attempts).toEqual([]);
    },
  );

  it('does nothing for a message that no longer exists', async () => {
    const { process, apiProvider } = setup();

    await process('0192f0c4-0000-7000-8000-999999999999');

    expect(apiProvider.sent).toEqual([]);
  });

  it('sends a message left in sending by a worker that stopped', async () => {
    const { queue, process, emails, apiProvider } = setup();
    const id = await queue();
    await emails.updateStatus(id, 'sending');

    await process(id, 2);

    expect(apiProvider.sent).toHaveLength(1);
    expect((await emails.findById(id))?.status).toBe('sent');
  });
});
