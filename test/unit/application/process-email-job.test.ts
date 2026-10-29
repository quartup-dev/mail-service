import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../src/application/ports/api-client-repository';
import { ProcessEmailJob } from '../../../src/application/process-email-job';
import { QueueEmail } from '../../../src/application/queue-email';
import type { EmailRequest } from '../../../src/domain/email';
import { PermanentProviderError, TransientProviderError } from '../../../src/domain/errors';
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

const CLIENT: ApiClient = {
  id: 'billing',
  name: 'Facturación',
  allowedTransports: ['smtp', 'api'],
};

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

  describe('suppression', () => {
    const threeRecipients = {
      to: [{ email: 'ok@dominio.com' }, { email: 'Rebote@Dominio.com' }],
      cc: [{ email: 'queja@dominio.com' }],
    };

    it('skips suppressed recipients of an api message and sends to the rest', async () => {
      const { queue, process, emails, suppressions, apiProvider } = setup();
      await suppressions.add('rebote@dominio.com', 'bounce', 'mailgun');
      await suppressions.add('queja@dominio.com', 'complaint', 'mailgun');
      const id = await queue(apiRequest(threeRecipients));

      await process(id);

      expect(apiProvider.sent).toHaveLength(1);
      expect(apiProvider.sent[0]).toMatchObject({ to: [{ email: 'ok@dominio.com' }], cc: [] });
      expect(await emails.findById(id)).toMatchObject({
        status: 'sent',
        recipients: [
          { email: 'ok@dominio.com', status: 'accepted' },
          { email: 'rebote@dominio.com', status: 'suppressed' },
          { email: 'queja@dominio.com', status: 'suppressed' },
        ],
      });
    });

    it('marks an api message as suppressed without sending it when every recipient is suppressed', async () => {
      const { queue, process, emails, suppressions, apiProvider } = setup();
      await suppressions.add('rebote@dominio.com', 'bounce', 'mailgun');
      const id = await queue(apiRequest({ to: [{ email: 'rebote@dominio.com' }] }));

      await process(id);

      expect(apiProvider.sent).toEqual([]);
      expect(await emails.findById(id)).toMatchObject({
        status: 'suppressed',
        recipients: [{ email: 'rebote@dominio.com', status: 'suppressed' }],
        attempts: [],
      });
    });

    it('does not apply to SMTP messages', async () => {
      const { queue, process, emails, suppressions, smtpSender } = setup();
      await suppressions.add('rebote@dominio.com', 'bounce', 'mailgun');
      const id = await queue(smtpRequest({ to: [{ email: 'rebote@dominio.com' }] }));

      await process(id);

      expect(smtpSender.sent).toHaveLength(1);
      expect((await emails.findById(id))?.recipients).toMatchObject([{ status: 'accepted' }]);
    });
  });

  it('keeps a delivered status that arrived before the worker stored its result', async () => {
    const { queue, process, emails, clock } = setup();
    const id = await queue(apiRequest({ to: [{ email: 'cliente@dominio.com' }] }));
    await emails.advanceRecipientStatus(id, 'cliente@dominio.com', 'delivered', clock.now());

    await process(id);

    expect((await emails.findById(id))?.recipients).toMatchObject([{ status: 'delivered' }]);
  });

  describe('failures', () => {
    const transient = () => new TransientProviderError('Too many requests', 'mailgun', '429');
    const permanent = () => new PermanentProviderError('Mailbox unavailable', 'smtp', '550');

    it('requeues on a transient error with attempts left, records it and rethrows', async () => {
      const { queue, process, emails, apiProvider } = setup();
      const id = await queue();
      apiProvider.failNextWith(transient());

      await expect(process(id, 1)).rejects.toBeInstanceOf(TransientProviderError);

      expect(await emails.findById(id)).toMatchObject({
        status: 'queued',
        attempts: [
          {
            attempt: 1,
            transport: 'api',
            provider: 'mailgun',
            outcome: 'transient_error',
            code: '429',
            message: 'Too many requests',
          },
        ],
      });
    });

    it('fails on a transient error in the last attempt and clears the SMTP configuration', async () => {
      const { queue, process, emails, smtpSender } = setup();
      const id = await queue(smtpRequest());
      smtpSender.failNextWith(new TransientProviderError('Try again later', 'smtp', '451'));

      await process(id, MAX_ATTEMPTS);

      expect(await emails.findById(id)).toMatchObject({
        status: 'failed',
        errorCode: '451',
        errorMessage: 'Try again later',
        smtpConfigEncrypted: null,
      });
    });

    it('fails on a permanent error, clears the SMTP configuration and rethrows', async () => {
      const { queue, process, emails, smtpSender } = setup();
      const id = await queue(smtpRequest());
      smtpSender.failNextWith(permanent());

      await expect(process(id, 1)).rejects.toBeInstanceOf(PermanentProviderError);

      expect(await emails.findById(id)).toMatchObject({
        status: 'failed',
        errorCode: '550',
        errorMessage: 'Mailbox unavailable',
        smtpConfigEncrypted: null,
        attempts: [{ outcome: 'permanent_error', code: '550' }],
      });
    });

    it('treats an unclassified error as transient', async () => {
      const { queue, process, emails, apiProvider } = setup();
      const id = await queue();
      const unexpected = new Error('socket hang up');
      apiProvider.failNextWith(unexpected);

      await expect(process(id, 1)).rejects.toBe(unexpected);

      expect(await emails.findById(id)).toMatchObject({
        status: 'queued',
        attempts: [
          { outcome: 'transient_error', code: 'UNEXPECTED_ERROR', message: 'socket hang up' },
        ],
      });
    });

    it('decrypts a configuration encrypted with the previous key and sends', async () => {
      const { queue, process, emails } = setup({
        workerSecretBox: new AesGcmSecretBox({ active: Buffer.alloc(32, 2), previous: KEY_A }),
      });
      const id = await queue(smtpRequest());

      await process(id);

      expect((await emails.findById(id))?.status).toBe('sent');
    });

    it('fails permanently with SMTP_CONFIG_UNDECRYPTABLE when the key is unknown', async () => {
      const { queue, process, emails, smtpSender } = setup({
        workerSecretBox: new AesGcmSecretBox({ active: Buffer.alloc(32, 2) }),
      });
      const id = await queue(smtpRequest());

      await expect(process(id)).rejects.toMatchObject({
        constructor: PermanentProviderError,
        code: 'SMTP_CONFIG_UNDECRYPTABLE',
      });

      expect(smtpSender.sent).toEqual([]);
      expect(await emails.findById(id)).toMatchObject({
        status: 'failed',
        errorCode: 'SMTP_CONFIG_UNDECRYPTABLE',
        smtpConfigEncrypted: null,
      });
    });

    it('fails permanently with SMTP_HOST_NOT_ALLOWED when the guard rejects the host before sending', async () => {
      const { queue, process, emails, smtpSender, smtpHostGuard } = setup();
      const id = await queue(smtpRequest());
      smtpHostGuard.block('smtp.example.com');

      await expect(process(id)).rejects.toMatchObject({
        constructor: PermanentProviderError,
        code: 'SMTP_HOST_NOT_ALLOWED',
      });

      expect(smtpSender.sent).toEqual([]);
      expect(await emails.findById(id)).toMatchObject({
        status: 'failed',
        errorCode: 'SMTP_HOST_NOT_ALLOWED',
        smtpConfigEncrypted: null,
      });
    });

    it('fails with API_TRANSPORT_NOT_CONFIGURED when the worker has no api provider', async () => {
      const { queue, process, emails } = setup({ withApiProvider: false });
      const id = await queue();

      await process(id);

      expect(await emails.findById(id)).toMatchObject({
        status: 'failed',
        errorCode: 'API_TRANSPORT_NOT_CONFIGURED',
        attempts: [],
      });
    });
  });
});
