import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { ProcessEmailJob } from '../../../../src/application/process-email-job';
import type { EmailMessage } from '../../../../src/domain/email';
import { PermanentProviderError, TransientProviderError } from '../../../../src/domain/errors';
import { AesGcmSecretBox } from '../../../../src/infrastructure/crypto/aes-gcm-secret-box';
import { InMemoryEmailRepository } from '../../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { InMemorySuppressionRepository } from '../../../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { createEmailProcessor, type EmailJob } from '../../../../src/interfaces/worker/email-consumer';
import { messageFrom } from '../../../support/email-messages';
import { FakeClock } from '../../../support/fake-clock';
import { FakeLogger } from '../../../support/fake-logger';
import { FakeApiProvider, FakeSmtpSender } from '../../../support/fake-senders';
import { FakeSmtpHostGuard } from '../../../support/fake-smtp-host-guard';

const MAX_ATTEMPTS = 5;

async function setup({ withApiProvider = true } = {}) {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const apiProvider = new FakeApiProvider(clock);
  const processor = createEmailProcessor(
    new ProcessEmailJob({
      emails,
      suppressions: new InMemorySuppressionRepository(clock),
      apiProvider: withApiProvider ? apiProvider : null,
      smtpSender: new FakeSmtpSender(clock),
      smtpHostGuard: new FakeSmtpHostGuard(),
      secretBox: new AesGcmSecretBox({ active: Buffer.alloc(32, 1) }),
      clock,
      logger: new FakeLogger(),
    }),
  );
  const message: EmailMessage = messageFrom();
  await emails.create({ message, clientId: 'billing', requestId: 'req-1', requestHash: 'hash' });
  const job = (attemptsMade: number): EmailJob => ({
    data: { messageId: message.id },
    attemptsMade,
    opts: { attempts: MAX_ATTEMPTS },
  });
  const statusOf = async () => (await emails.findById(message.id))?.status;
  return { processor, apiProvider, job, statusOf };
}

describe('email consumer', () => {
  it('processes the message of the job', async () => {
    const { processor, job, statusOf } = await setup();

    await processor(job(0));

    expect(await statusOf()).toBe('sent');
  });

  it('counts attempts from one, so a failure after four failed attempts is the last one', async () => {
    const { processor, apiProvider, job, statusOf } = await setup();
    apiProvider.failNextWith(
      new TransientProviderError('Busy', 'mailgun', '429'),
      new TransientProviderError('Busy', 'mailgun', '429'),
    );

    await expect(processor(job(0))).rejects.toBeInstanceOf(TransientProviderError);
    expect(await statusOf()).toBe('queued');

    await expect(processor(job(MAX_ATTEMPTS - 1))).rejects.toBeInstanceOf(TransientProviderError);
    expect(await statusOf()).toBe('failed');
  });

  it('turns a permanent provider error into an UnrecoverableError', async () => {
    const { processor, apiProvider, job } = await setup();
    apiProvider.failNextWith(new PermanentProviderError('Rejected', 'mailgun', '400'));

    await expect(processor(job(0))).rejects.toThrow(UnrecoverableError);
  });

  it('turns a rejected request into an UnrecoverableError', async () => {
    const { processor, job } = await setup({ withApiProvider: false });

    await expect(processor(job(0))).rejects.toThrow(UnrecoverableError);
  });
});
