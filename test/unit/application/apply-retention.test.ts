import { describe, expect, it } from 'vitest';
import { ApplyRetention } from '../../../src/application/apply-retention';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { messageFrom } from '../../support/email-messages';
import { FakeClock } from '../../support/fake-clock';

const DAY = 86_400_000;

function setup({ batchSize = 100 } = {}) {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const useCase = new ApplyRetention({
    emails,
    clock,
    payloadRetentionDays: 7,
    eventsRetentionDays: 90,
    messageRetentionDays: 365,
    batchSize,
  });
  const store = async (status: 'sent' | 'queued' = 'sent') => {
    const { email } = await emails.create({
      message: messageFrom(),
      clientId: 'billing',
      requestId: 'req-1',
      requestHash: 'hash-1',
    });
    if (status === 'sent') await emails.updateStatus(email.id, 'sent');
    await emails.recordEvent({
      emailId: email.id,
      recipient: 'cliente@dominio.com',
      provider: 'mailgun',
      type: 'delivered',
      raw: {},
      occurredAt: clock.now(),
      receivedAt: clock.now(),
    });
    return email.id;
  };
  return { clock, emails, useCase, store };
}

describe('ApplyRetention', () => {
  it('clears payloads, deletes events and deletes final messages according to their periods', async () => {
    const { clock, emails, useCase, store } = setup();
    const id = await store();

    clock.advance(7 * DAY + 1);
    expect(await useCase.execute()).toEqual({
      payloadsCleared: 1,
      eventsDeleted: 0,
      emailsDeleted: 0,
    });
    expect(await emails.findById(id)).toMatchObject({ payload: null, status: 'sent' });

    clock.advance(83 * DAY);
    expect(await useCase.execute()).toEqual({
      payloadsCleared: 0,
      eventsDeleted: 1,
      emailsDeleted: 0,
    });

    clock.advance(275 * DAY);
    expect(await useCase.execute()).toEqual({
      payloadsCleared: 0,
      eventsDeleted: 0,
      emailsDeleted: 1,
    });
    expect(await emails.findById(id)).toBeNull();
  });

  it('does not touch pending messages', async () => {
    const { clock, emails, useCase, store } = setup();
    const id = await store('queued');
    clock.advance(400 * DAY);

    await useCase.execute();

    const email = await emails.findById(id);
    expect(email?.status).toBe('queued');
    expect(email?.payload).not.toBeNull();
  });

  it('processes in batches until no rows are left', async () => {
    const { clock, useCase, store } = setup({ batchSize: 2 });
    for (let i = 0; i < 5; i++) await store();
    clock.advance(366 * DAY);

    expect(await useCase.execute()).toEqual({
      payloadsCleared: 5,
      eventsDeleted: 5,
      emailsDeleted: 5,
    });
  });
});
