import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BullMqEmailQueue } from '../../../src/infrastructure/queue/bullmq-email-queue';
import { TEST_REDIS_URL } from '../../support/integration';

const connection = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });

afterAll(async () => {
  await connection.quit();
});

describe('BullMqEmailQueue', () => {
  let prefix: string;
  let emailQueue: BullMqEmailQueue;
  let inspectors: Record<'api' | 'smtp', Queue>;

  beforeEach(() => {
    prefix = `test-${randomUUID()}`;
    emailQueue = new BullMqEmailQueue(connection, {
      maxAttempts: 5,
      backoffBaseMs: 30_000,
      prefix,
    });
    inspectors = {
      api: new Queue('emails-api', { connection, prefix }),
      smtp: new Queue('emails-smtp', { connection, prefix }),
    };
  });

  afterEach(async () => {
    await emailQueue.close();
    for (const queue of Object.values(inspectors)) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it.each(['api', 'smtp'] as const)(
    'enqueues a %s message in its queue with the message id as job id and as only data',
    async (transport) => {
      const messageId = randomUUID();

      await emailQueue.enqueue(messageId, transport);

      const job = await inspectors[transport].getJob(messageId);
      expect(job?.data).toEqual({ messageId });
      const other = transport === 'api' ? 'smtp' : 'api';
      expect(await inspectors[other].count()).toBe(0);
    },
  );

  it('keeps a single job when the same message is enqueued twice', async () => {
    const messageId = randomUUID();

    await emailQueue.enqueue(messageId, 'api');
    await emailQueue.enqueue(messageId, 'api');

    expect(await inspectors.api.count()).toBe(1);
  });

  it('configures retries with exponential backoff and jitter, and removes finished jobs', async () => {
    const messageId = randomUUID();

    await emailQueue.enqueue(messageId, 'smtp');

    const job = await inspectors.smtp.getJob(messageId);
    expect(job?.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000, jitter: 0.5 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});
