import { Redis } from 'ioredis';
import { ApplyRetention } from '../application/apply-retention';
import type { Logger } from '../application/ports/logger';
import { ProcessEmailJob } from '../application/process-email-job';
import { SweepPendingEmails } from '../application/sweep-pending-emails';
import { HealthServer } from '../interfaces/worker/health-server';
import { WorkerRuntime } from '../interfaces/worker/worker-runtime';
import type { WorkerConfig } from './config';
import { AesGcmSecretBox } from './crypto/aes-gcm-secret-box';
import { connectDatabase } from './db/client';
import { DrizzleEmailRepository } from './db/drizzle-email-repository';
import { DrizzleSuppressionRepository } from './db/drizzle-suppression-repository';
import { UnavailableSmtpHostGuard, UnavailableSmtpSender } from './providers/unavailable';
import { BullMqEmailQueue } from './queue/bullmq-email-queue';
import { SystemClock } from './system-clock';

const MAINTENANCE_BATCH_SIZE = 1_000;
const RETENTION_INTERVAL_MS = 3_600_000;

export interface WorkerContainer {
  runtime: WorkerRuntime;
  health: HealthServer;
  close(): Promise<void>;
}

// Conexiones, pools y clientes se crean una sola vez por proceso
export function createWorkerContainer(config: WorkerConfig, logger: Logger): WorkerContainer {
  const { db, pool } = connectDatabase(config.databaseUrl);
  // BullMQ exige maxRetriesPerRequest: null en las conexiones de sus workers
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const clock = new SystemClock();
  const emails = new DrizzleEmailRepository(db, clock);
  const emailQueue = new BullMqEmailQueue(redis, {
    maxAttempts: config.worker.maxAttempts,
    backoffBaseMs: config.worker.backoffBaseMs,
  });

  const runtime = new WorkerRuntime({
    connection: redis,
    queues: config.worker.queues,
    concurrency: { api: config.worker.apiConcurrency, smtp: config.worker.smtpConcurrency },
    apiRateLimitPerSecond: config.worker.apiRateLimitPerSecond,
    sweepIntervalMs: config.maintenance.sweepIntervalMs,
    retentionIntervalMs: RETENTION_INTERVAL_MS,
    processEmailJob: new ProcessEmailJob({
      emails,
      suppressions: new DrizzleSuppressionRepository(db, clock),
      apiProvider: null, // los adaptadores de Mailgun y SES llegan en la fase 4
      smtpSender: new UnavailableSmtpSender(),
      smtpHostGuard: new UnavailableSmtpHostGuard(),
      secretBox: new AesGcmSecretBox({
        active: config.smtpEncryptionKey,
        ...(config.smtpEncryptionKeyPrevious && { previous: config.smtpEncryptionKeyPrevious }),
      }),
      clock,
      logger,
    }),
    maintenance: {
      sweepPendingEmails: new SweepPendingEmails({
        emails,
        queue: emailQueue,
        clock,
        pendingMaxAgeMs: config.maintenance.pendingMaxAgeMs,
        stalePendingAfterMs: config.maintenance.stalePendingAfterMs,
        batchSize: MAINTENANCE_BATCH_SIZE,
      }),
      applyRetention: new ApplyRetention({
        emails,
        clock,
        payloadRetentionDays: config.maintenance.payloadRetentionDays,
        eventsRetentionDays: config.maintenance.eventsRetentionDays,
        messageRetentionDays: config.maintenance.messageRetentionDays,
        batchSize: MAINTENANCE_BATCH_SIZE,
      }),
    },
    logger,
  });

  const health = new HealthServer({
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    redis: async () => {
      await redis.ping();
    },
    workersRunning: () => runtime.isRunning(),
  });

  return {
    runtime,
    health,
    // Tras cerrar el runtime (que espera a los jobs activos): colas, Redis y PostgreSQL
    async close() {
      await emailQueue.close();
      await redis.quit();
      await pool.end();
    },
  };
}
