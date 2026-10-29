import { describe, expect, it } from 'vitest';
import { SweepPendingEmails } from '../../../src/application/sweep-pending-emails';
import type { EmailRequest } from '../../../src/domain/email';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { messageFrom } from '../../support/email-messages';
import { apiRequest, smtpRequest } from '../../support/email-requests';
import { FakeClock } from '../../support/fake-clock';
import { FakeEmailQueue } from '../../support/fake-email-queue';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function setup({ batchSize = 100 } = {}) {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const queue = new FakeEmailQueue();
  const useCase = new SweepPendingEmails({
    emails,
    queue,
    clock,
    pendingMaxAgeMs: 24 * HOUR,
    stalePendingAfterMs: 10 * MINUTE,
    batchSize,
  });
  const store = async (request: EmailRequest = apiRequest()) =>
    (
      await emails.create({
        message: messageFrom(request),
        clientId: 'billing',
        requestId: 'req-1',
        requestHash: 'hash-1',
        ...(request.transport.type === 'smtp' && { smtpConfigEncrypted: 'key-id:encrypted' }),
      })
    ).email.id;
  return { clock, emails, queue, useCase, store };
}

describe('SweepPendingEmails', () => {
  it('expires pending messages older than the maximum age and clears their SMTP configuration', async () => {
    const { clock, emails, queue, useCase, store } = setup();
    const id = await store(smtpRequest());
    clock.advance(24 * HOUR + 1);

    const result = await useCase.execute();

    expect(result.expired).toBe(1);
    expect(await emails.findById(id)).toMatchObject({
      status: 'failed',
      errorCode: 'EXPIRED',
      smtpConfigEncrypted: null,
    });
    expect(queue.jobs.size).toBe(0);
  });

  it('enqueues again the pending messages without recent activity', async () => {
    const { clock, emails, queue, useCase, store } = setup();
    const queued = await store();
    const sending = await store(smtpRequest());
    await emails.updateStatus(sending, 'sending');
    clock.advance(10 * MINUTE + 1);

    const result = await useCase.execute();

    expect(result).toEqual({ expired: 0, requeued: 2 });
    expect(queue.jobs).toEqual(
      new Map([
        [queued, 'api'],
        [sending, 'smtp'],
      ]),
    );
  });

  it('leaves recent pending messages and old final messages alone', async () => {
    const { clock, emails, queue, useCase, store } = setup();
    const final = await store();
    await emails.updateStatus(final, 'sent');
    clock.advance(25 * HOUR);
    const recent = await store();

    const result = await useCase.execute();

    expect(result).toEqual({ expired: 0, requeued: 0 });
    expect(queue.jobs.size).toBe(0);
    expect((await emails.findById(final))?.status).toBe('sent');
    expect((await emails.findById(recent))?.status).toBe('queued');
  });

  it('expires in batches until no old pending message is left', async () => {
    const { clock, emails, useCase, store } = setup({ batchSize: 2 });
    const ids = [await store(), await store(), await store(), await store(), await store()];
    clock.advance(24 * HOUR + 1);

    const result = await useCase.execute();

    expect(result.expired).toBe(5);
    for (const id of ids) expect((await emails.findById(id))?.status).toBe('failed');
  });
});
