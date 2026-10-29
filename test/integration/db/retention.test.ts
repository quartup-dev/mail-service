import { afterAll, describe, expect, it } from 'vitest';
import { ApplyRetention } from '../../../src/application/apply-retention';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { DrizzleEmailRepository } from '../../../src/infrastructure/db/drizzle-email-repository';
import { DrizzleSuppressionRepository } from '../../../src/infrastructure/db/drizzle-suppression-repository';
import { messageFrom } from '../../support/email-messages';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const DAY = 86_400_000;
const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describe('ApplyRetention with Drizzle', () => {
  it('applies every period in batches and leaves pending messages and suppressions alone', async () => {
    await resetTables(db);
    const clock = new FakeClock();
    const emails = new DrizzleEmailRepository(db, clock);
    const suppressions = new DrizzleSuppressionRepository(db, clock);
    const store = async () =>
      (
        await emails.create({
          message: messageFrom(),
          clientId: 'billing',
          requestId: 'req-1',
          requestHash: 'hash',
        })
      ).email.id;
    const finalIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await store();
      await emails.updateStatus(id, 'sent');
      await emails.recordEvent({
        emailId: id,
        recipient: 'cliente@dominio.com',
        provider: 'mailgun',
        type: 'delivered',
        raw: { event: 'delivered' },
        occurredAt: clock.now(),
        receivedAt: clock.now(),
      });
      finalIds.push(id);
    }
    const pendingId = await store();
    await suppressions.add('rebote@dominio.com', 'bounce', 'mailgun');
    clock.advance(366 * DAY);

    const result = await new ApplyRetention({
      emails,
      clock,
      payloadRetentionDays: 7,
      eventsRetentionDays: 90,
      messageRetentionDays: 365,
      batchSize: 2,
    }).execute();

    expect(result).toEqual({ payloadsCleared: 5, eventsDeleted: 5, emailsDeleted: 5 });
    for (const id of finalIds) expect(await emails.findById(id)).toBeNull();
    expect((await emails.findById(pendingId))?.payload).not.toBeNull();
    expect(await suppressions.findSuppressed(['rebote@dominio.com'])).toEqual(
      new Set(['rebote@dominio.com']),
    );
  });
});
