import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ApplyRetention } from '../../../src/application/apply-retention';
import { ProcessEmailJob } from '../../../src/application/process-email-job';
import { QueueEmail } from '../../../src/application/queue-email';
import { SweepPendingEmails } from '../../../src/application/sweep-pending-emails';
import type { EmailRequest, EmailStatus } from '../../../src/domain/email';
import { AesGcmSecretBox } from '../../../src/infrastructure/crypto/aes-gcm-secret-box';
import { UuidV7IdGenerator } from '../../../src/infrastructure/crypto/uuid-v7-id-generator';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { DrizzleEmailRepository } from '../../../src/infrastructure/db/drizzle-email-repository';
import { DrizzleSuppressionRepository } from '../../../src/infrastructure/db/drizzle-suppression-repository';
import { BullMqEmailQueue } from '../../../src/infrastructure/queue/bullmq-email-queue';
import {
  WorkerRuntime,
  type WorkerRuntimeOptions,
} from '../../../src/interfaces/worker/worker-runtime';
import { PermanentProviderError, TransientProviderError } from '../../../src/domain/errors';
import { messageFrom } from '../../support/email-messages';
import { apiRequest, smtpRequest } from '../../support/email-requests';
import { FakeClock } from '../../support/fake-clock';
import { FakeLogger } from '../../support/fake-logger';
import { FakeApiProvider, FakeSmtpSender } from '../../support/fake-senders';
import { FakeSmtpHostGuard } from '../../support/fake-smtp-host-guard';
import { resetTables, TEST_DATABASE_URL, TEST_REDIS_URL } from '../../support/integration';
import { waitFor } from '../../support/wait-for';

const MAX_ATTEMPTS = 3;

// Cuenta las consultas de pendientes para saber cuántos barridos se han ejecutado (dos por barrido)
class CountingEmailRepository extends DrizzleEmailRepository {
  findPendingCalls = 0;

  override findPending(...args: Parameters<DrizzleEmailRepository['findPending']>) {
    this.findPendingCalls++;
    return super.findPending(...args);
  }
}
const MINUTE = 60_000;

const connection = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await connection.quit();
  await pool.end();
});

describe('WorkerRuntime', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(overrides: Partial<WorkerRuntimeOptions> = {}) {
    await resetTables(db);
    const prefix = `test-${randomUUID()}`;
    const clock = new FakeClock();
    const emails = new CountingEmailRepository(db, clock);
    const suppressions = new DrizzleSuppressionRepository(db, clock);
    const emailQueue = new BullMqEmailQueue(connection, {
      maxAttempts: MAX_ATTEMPTS,
      backoffBaseMs: 10,
      prefix,
    });
    const apiProvider = new FakeApiProvider(clock);
    const smtpSender = new FakeSmtpSender(clock);
    const smtpHostGuard = new FakeSmtpHostGuard();
    const secretBox = new AesGcmSecretBox({ active: Buffer.alloc(32, 1) });
    const logger = new FakeLogger();

    const queueEmail = new QueueEmail({
      emails,
      queue: emailQueue,
      smtpHostGuard,
      secretBox,
      ids: new UuidV7IdGenerator(),
      logger,
      apiProviderName: apiProvider.name,
      allowedFromDomains: ['example.com'],
      requestHashPepper: Buffer.alloc(32, 3),
    });

    const createRuntime = (runtimeOverrides: Partial<WorkerRuntimeOptions>) =>
      new WorkerRuntime({
        connection,
        prefix,
        queues: ['api', 'smtp'],
        concurrency: { api: 5, smtp: 1 },
        apiRateLimitPerSecond: 1_000,
        sweepIntervalMs: 100,
        retentionIntervalMs: 3_600_000,
        processEmailJob: new ProcessEmailJob({
          emails,
          suppressions,
          apiProvider,
          smtpSender,
          smtpHostGuard,
          secretBox,
          clock,
          logger,
        }),
        maintenance: {
          sweepPendingEmails: new SweepPendingEmails({
            emails,
            queue: emailQueue,
            clock,
            pendingMaxAgeMs: 24 * 60 * MINUTE,
            stalePendingAfterMs: 10 * MINUTE,
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
        },
        logger,
        ...overrides,
        ...runtimeOverrides,
      });

    const startRuntime = async (runtimeOverrides: Partial<WorkerRuntimeOptions> = {}) => {
      const runtime = createRuntime(runtimeOverrides);
      cleanups.push(() => runtime.close());
      await runtime.start();
      return runtime;
    };

    cleanups.push(async () => {
      await emailQueue.close();
      for (const name of ['emails-api', 'emails-smtp', 'maintenance']) {
        const queue = new Queue(name, { connection, prefix });
        await queue.obliterate({ force: true });
        await queue.close();
      }
    });

    const send = async (request: EmailRequest) =>
      (
        await queueEmail.execute({
          client: { id: 'billing', name: 'billing', allowedTransports: ['smtp', 'api'] },
          request,
          requestId: 'req-1',
        })
      ).email.id;

    const statusOf = async (id: string) => (await emails.findById(id))?.status;
    const waitForStatus = (id: string, status: EmailStatus, options?: { timeoutMs?: number }) =>
      waitFor(async () => (await statusOf(id)) === status, options);

    return {
      prefix,
      logger,
      emailQueue,
      clock,
      emails,
      apiProvider,
      smtpSender,
      send,
      statusOf,
      waitForStatus,
      startRuntime,
    };
  }

  it('sends messages through both transports and clears the SMTP configuration', async () => {
    const { send, emails, waitForStatus, startRuntime } = await setup();
    await startRuntime();

    const apiId = await send(apiRequest());
    const smtpId = await send(smtpRequest());

    await waitForStatus(apiId, 'sent');
    await waitForStatus(smtpId, 'sent');
    expect((await emails.findById(smtpId))?.smtpConfigEncrypted).toBeNull();
  });

  it('sends a message stored without a job thanks to the periodic sweep', async () => {
    const { clock, emails, waitForStatus, startRuntime, apiProvider } = await setup();
    const { email } = await emails.create({
      message: messageFrom(apiRequest()),
      clientId: 'billing',
      requestId: 'req-1',
      requestHash: 'hash',
    });
    await startRuntime();
    // El scheduler ejecuta un barrido al registrarse; el mensaje aún no está sin actividad
    await waitFor(() => emails.findPendingCalls >= 2);
    clock.advance(10 * MINUTE + 1);

    await waitForStatus(email.id, 'sent', { timeoutMs: 2_000 });
    expect(apiProvider.sent.map((message) => message.id)).toEqual([email.id]);
  });

  it('keeps sending api messages while a slow SMTP server uses all the SMTP concurrency', async () => {
    const { send, smtpSender, statusOf, waitForStatus, startRuntime } = await setup();
    const release = smtpSender.hold();
    await startRuntime();

    const smtpId = await send(smtpRequest());
    await waitFor(() => smtpSender.startedCount === 1);
    const apiIds = [await send(apiRequest()), await send(apiRequest())];

    for (const id of apiIds) await waitForStatus(id, 'sent');
    expect(await statusOf(smtpId)).toBe('sending');
    release();
    await waitForStatus(smtpId, 'sent');
  });

  it('does not retry a permanent error', async () => {
    const { send, emails, apiProvider, waitForStatus, startRuntime } = await setup();
    apiProvider.failNextWith(new PermanentProviderError('Rejected', 'mailgun', '400'));
    await startRuntime();

    const id = await send(apiRequest());

    await waitForStatus(id, 'failed');
    expect((await emails.findById(id))?.attempts).toHaveLength(1);
  });

  it('retries a transient error until the attempts run out and leaves the message failed', async () => {
    const { send, emails, apiProvider, waitForStatus, startRuntime } = await setup();
    apiProvider.failNextWith(
      ...Array.from(
        { length: MAX_ATTEMPTS },
        () => new TransientProviderError('Busy', 'mailgun', '429'),
      ),
    );
    await startRuntime();

    const id = await send(apiRequest());

    await waitForStatus(id, 'failed');
    expect((await emails.findById(id))?.attempts.map((attempt) => attempt.attempt)).toEqual([
      1, 2, 3,
    ]);
  });

  it('only consumes the configured email queues', async () => {
    const { send, statusOf, waitForStatus, startRuntime } = await setup({ queues: ['api'] });
    await startRuntime();

    const smtpId = await send(smtpRequest());
    const apiId = await send(apiRequest());

    await waitForStatus(apiId, 'sent');
    expect(await statusOf(smtpId)).toBe('queued');
  });

  it('registers each maintenance scheduler once even with two workers', async () => {
    const { prefix, startRuntime } = await setup();

    await startRuntime();
    await startRuntime();

    const maintenance = new Queue('maintenance', { connection, prefix });
    const schedulers = await maintenance.getJobSchedulers();
    await maintenance.close();
    expect(schedulers.map((scheduler) => scheduler.key).sort()).toEqual([
      'apply-retention',
      'sweep-pending-emails',
    ]);
  });

  it('waits for active jobs before closing', async () => {
    const { send, smtpSender, statusOf, startRuntime } = await setup();
    const release = smtpSender.hold();
    const runtime = await startRuntime();
    const id = await send(smtpRequest());
    await waitFor(() => smtpSender.startedCount === 1);

    let closed = false;
    const closing = runtime.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(false);
    expect(runtime.isRunning()).toBe(false);

    release();
    await closing;
    expect(await statusOf(id)).toBe('sent');
  });

  it('processes as many api messages in parallel as the api concurrency', async () => {
    const { send, apiProvider, startRuntime } = await setup({ concurrency: { api: 2, smtp: 1 } });
    const release = apiProvider.hold();
    await startRuntime();

    for (let i = 0; i < 3; i++) await send(apiRequest());

    await waitFor(() => apiProvider.startedCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(apiProvider.startedCount).toBe(2);
    release();
  });

  it('limits the api queue to the configured messages per second', async () => {
    const { send, apiProvider, startRuntime } = await setup({ apiRateLimitPerSecond: 2 });
    await startRuntime();

    for (let i = 0; i < 4; i++) await send(apiRequest());

    await waitFor(() => apiProvider.sent.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(apiProvider.sent).toHaveLength(2);
    await waitFor(() => apiProvider.sent.length === 4, { timeoutMs: 3_000 });
  });

  it('does not keep finished maintenance jobs in Redis', async () => {
    const { prefix, emails, startRuntime } = await setup();
    await startRuntime();

    // Dos barridos: el primero ya ha terminado
    await waitFor(() => emails.findPendingCalls >= 4);

    const maintenance = new Queue('maintenance', { connection, prefix });
    const counts = await maintenance.getJobCounts('completed', 'failed');
    await maintenance.close();
    expect(counts).toEqual({ completed: 0, failed: 0 });
  });

  it('logs a failed maintenance job', async () => {
    const { logger, emails, emailQueue, startRuntime } = await setup();
    const failingEmails = Object.create(emails) as CountingEmailRepository;
    failingEmails.findPending = () => Promise.reject(new Error('database unavailable'));
    const clock = new FakeClock();

    await startRuntime({
      maintenance: {
        sweepPendingEmails: new SweepPendingEmails({
          emails: failingEmails,
          queue: emailQueue,
          clock,
          pendingMaxAgeMs: MINUTE,
          stalePendingAfterMs: MINUTE,
          batchSize: 10,
        }),
        applyRetention: new ApplyRetention({
          emails,
          clock,
          payloadRetentionDays: 7,
          eventsRetentionDays: 90,
          messageRetentionDays: 365,
          batchSize: 10,
        }),
      },
    });

    await waitFor(() => logger.entries.some((entry) => entry.message === 'Maintenance job failed'));
    expect(
      logger.entries.find((entry) => entry.message === 'Maintenance job failed'),
    ).toMatchObject({ level: 'error', bindings: { job: 'sweep-pending-emails' } });
  });
});
