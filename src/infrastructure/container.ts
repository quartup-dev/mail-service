import type { FastifyInstance } from 'fastify';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import FormData from 'form-data';
import { Redis, type RedisOptions } from 'ioredis';
import Mailgun from 'mailgun.js';
import nodemailer from 'nodemailer';
import packageJson from '../../package.json' with { type: 'json' };
import { ApplyRetention } from '../application/apply-retention';
import type { FastifyBaseLogger as FastifyLogger } from 'fastify';
import type { EmailApiProvider } from '../application/ports/email-api-provider';
import type { Clock } from '../application/ports/clock';
import type { Logger } from '../application/ports/logger';
import { GetEmailStatus } from '../application/get-email-status';
import { HandleProviderEvent } from '../application/handle-provider-event';
import { ProcessEmailJob } from '../application/process-email-job';
import { QueueEmail } from '../application/queue-email';
import { SweepPendingEmails } from '../application/sweep-pending-emails';
import { buildApp } from '../interfaces/http/app';
import { HealthServer } from '../interfaces/worker/health-server';
import { WorkerRuntime } from '../interfaces/worker/worker-runtime';
import { DrizzleApiClientRepository } from './auth/drizzle-api-client-repository';
import type { ApiConfig, WorkerConfig } from './config';
import { UuidV7IdGenerator } from './crypto/uuid-v7-id-generator';
import { AesGcmSecretBox } from './crypto/aes-gcm-secret-box';
import { connectDatabase } from './db/client';
import { DrizzleEmailRepository } from './db/drizzle-email-repository';
import { DrizzleSuppressionRepository } from './db/drizzle-suppression-repository';
import { DnsSmtpHostGuard, lookupAllAddresses } from './net/dns-smtp-host-guard';
import { MailgunApiProvider, mailgunClientOptions } from './providers/mailgun-api-provider';
import { NodemailerSmtpSender } from './providers/nodemailer-smtp-sender';
import { SesApiProvider, sesClientConfig } from './providers/ses-api-provider';
import { BullMqEmailQueue } from './queue/bullmq-email-queue';
import { SystemClock } from './system-clock';
import { MailgunWebhookVerifier } from './webhooks/mailgun-webhook-verifier';
import { RedisReplayGuard } from './webhooks/redis-replay-guard';

const MAINTENANCE_BATCH_SIZE = 1_000;

const RETENTION_INTERVAL_MS = 3_600_000;

// Un cliente por proceso. Sus errores (reconexiones) van al log en lugar de a la consola
function connectRedis(url: string, options: RedisOptions, logger: Logger): Redis {
  const redis = new Redis(url, options);
  redis.on('error', (error) => logger.warn({ err: error }, 'Redis connection error'));
  return redis;
}

// quit() falla si la conexión no está abierta (Redis caído): en ese caso basta con cortarla
async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') await redis.quit();
  else redis.disconnect();
}

// Un cliente del proveedor por proceso, según MAIL_API_PROVIDER; null deshabilita el transporte api
function createApiProvider(
  provider: WorkerConfig['mailApiProvider'],
  clock: Clock,
): EmailApiProvider | null {
  switch (provider?.name) {
    case 'mailgun':
      return new MailgunApiProvider({
        messages: new Mailgun(FormData).client(mailgunClientOptions(provider)).messages,
        domain: provider.domain,
        clock,
      });
    case 'ses':
      return new SesApiProvider({
        client: new SESv2Client(sesClientConfig(provider)),
        configurationSet: provider.configurationSet,
        clock,
      });
    default:
      return null;
  }
}

function createSmtpHostGuard(config: WorkerConfig | ApiConfig): DnsSmtpHostGuard {
  return new DnsSmtpHostGuard(
    {
      allowedHosts: config.smtp.allowedHosts,
      allowedPrivateHosts: config.smtp.allowedPrivateHosts,
    },
    lookupAllAddresses,
  );
}

export interface WorkerContainer {
  runtime: WorkerRuntime;
  health: HealthServer;
  close(): Promise<void>;
}

// Conexiones, pools y clientes se crean una sola vez por proceso
export function createWorkerContainer(config: WorkerConfig, logger: Logger): WorkerContainer {
  const { db, pool } = connectDatabase(config.databaseUrl);
  // BullMQ exige maxRetriesPerRequest: null en las conexiones de sus workers
  const redis = connectRedis(config.redisUrl, { maxRetriesPerRequest: null }, logger);
  const clock = new SystemClock();
  const emails = new DrizzleEmailRepository(db, clock);
  const smtpSender = new NodemailerSmtpSender({
    createTransport: (options) => nodemailer.createTransport(options),
    clock,
    settings: config.smtp,
  });
  const emailQueue = new BullMqEmailQueue(redis, {
    maxAttempts: config.worker.maxAttempts,
    backoffBaseMs: config.worker.backoffBaseMs,
    logger,
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
      apiProvider: createApiProvider(config.mailApiProvider, clock),
      smtpSender,
      smtpHostGuard: createSmtpHostGuard(config),
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
    // Tras cerrar el runtime (que espera a los jobs activos): pools SMTP, colas, Redis y PostgreSQL
    async close() {
      smtpSender.close();
      await emailQueue.close();
      await closeRedis(redis);
      await pool.end();
    },
  };
}

export interface ApiContainer {
  app: FastifyInstance;
}

// Las conexiones se cierran en onClose: server.ts solo llama a app.close()
export function createApiContainer(
  config: ApiConfig,
  logger: Logger & FastifyLogger,
): ApiContainer {
  const { db, pool } = connectDatabase(config.databaseUrl);
  // Sin cola offline: si Redis no responde, encolar falla enseguida y el barrido recoge el mensaje
  const redis = connectRedis(
    config.redisUrl,
    { enableOfflineQueue: false, maxRetriesPerRequest: 1 },
    logger,
  );
  const clock = new SystemClock();
  const emails = new DrizzleEmailRepository(db, clock);
  const emailQueue = new BullMqEmailQueue(redis, { ...config.jobs, logger });

  const app = buildApp({
    logger,
    limits: {
      maxBodyBytes: config.maxBodyBytes,
      maxAttachmentsBytes: config.maxAttachmentsBytes,
      rateLimitDefaultPerMinute: config.rateLimitDefaultPerMinute,
    },
    apiClients: new DrizzleApiClientRepository(db, config.apiKeyPepper, clock),
    queueEmail: new QueueEmail({
      emails,
      queue: emailQueue,
      smtpHostGuard: createSmtpHostGuard(config),
      secretBox: new AesGcmSecretBox({
        active: config.smtpEncryptionKey,
        ...(config.smtpEncryptionKeyPrevious && { previous: config.smtpEncryptionKeyPrevious }),
      }),
      ids: new UuidV7IdGenerator(),
      logger,
      apiProviderName: config.mailApiProvider?.name ?? null,
      allowedFromDomains: config.allowedFromDomains,
      requestHashPepper: config.apiKeyPepper,
    }),
    getEmailStatus: new GetEmailStatus({ emails }),
    rateLimitRedis: redis,
    readiness: {
      postgres: async () => {
        await pool.query('SELECT 1');
      },
      redis: async () => {
        await redis.ping();
      },
      // La API no tiene las credenciales de envío del proveedor (solo las de sus webhooks)
      apiProvider: null,
    },
    version: packageJson.version,
    webhooks: {
      handleProviderEvent: new HandleProviderEvent({
        emails,
        suppressions: new DrizzleSuppressionRepository(db, clock),
        clock,
      }),
      mailgun:
        config.mailApiProvider?.name === 'mailgun'
          ? new MailgunWebhookVerifier({
              signingKey: config.mailApiProvider.webhookSigningKey,
              replayGuard: new RedisReplayGuard(redis),
              clock,
            })
          : null,
    },
  });

  app.addHook('onClose', async () => {
    await emailQueue.close();
    await closeRedis(redis);
    await pool.end();
  });
  return { app };
}
