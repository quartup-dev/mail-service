import { describe, expect, it } from 'vitest';
import { ApplyRetention } from '../../../../src/application/apply-retention';
import { SweepPendingEmails } from '../../../../src/application/sweep-pending-emails';
import { InMemoryEmailRepository } from '../../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { MAINTENANCE_JOBS } from '../../../../src/infrastructure/queue/queue-names';
import { createMaintenanceProcessor } from '../../../../src/interfaces/worker/maintenance-consumer';
import { messageFrom } from '../../../support/email-messages';
import { FakeClock } from '../../../support/fake-clock';
import { FakeEmailQueue } from '../../../support/fake-email-queue';

const DAY = 86_400_000;

async function setup() {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const processor = createMaintenanceProcessor({
    sweepPendingEmails: new SweepPendingEmails({
      emails,
      queue: new FakeEmailQueue(),
      clock,
      pendingMaxAgeMs: DAY,
      stalePendingAfterMs: 600_000,
      batchSize: 100,
    }),
    applyRetention: new ApplyRetention({
      emails,
      clock,
      payloadRetentionDays: 7,
      eventsRetentionDays: 90,
      messageRetentionDays: 365,
      batchSize: 100,
    }),
  });
  const { email } = await emails.create({
    message: messageFrom(),
    clientId: 'billing',
    requestId: 'req-1',
    requestHash: 'hash',
  });
  return { clock, emails, processor, id: email.id };
}

describe('maintenance consumer', () => {
  it('runs the sweep for a sweep job', async () => {
    const { clock, emails, processor, id } = await setup();
    clock.advance(DAY + 1);

    const result = await processor({ name: MAINTENANCE_JOBS.sweepPendingEmails });

    expect(result).toEqual({ expired: 1, requeued: 0 });
    expect((await emails.findById(id))?.status).toBe('failed');
  });

  it('applies retention for a retention job', async () => {
    const { clock, emails, processor, id } = await setup();
    await emails.updateStatus(id, 'sent');
    clock.advance(8 * DAY);

    const result = await processor({ name: MAINTENANCE_JOBS.applyRetention });

    expect(result).toEqual({ payloadsCleared: 1, eventsDeleted: 0, emailsDeleted: 0 });
    expect((await emails.findById(id))?.payload).toBeNull();
  });

  it('fails on an unknown job name', async () => {
    const { processor } = await setup();

    await expect(processor({ name: 'defragment' })).rejects.toThrow('defragment');
  });
});
