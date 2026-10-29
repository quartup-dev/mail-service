import { Queue, type ConnectionOptions } from 'bullmq';
import type { EmailQueue } from '../../application/ports/email-queue';
import type { TransportType } from '../../domain/email';
import { EMAIL_QUEUE_BY_TRANSPORT, type EmailJobData } from './queue-names';

const BACKOFF_JITTER = 0.5;

export interface EmailQueueSettings {
  maxAttempts: number; // WORKER_MAX_ATTEMPTS
  backoffBaseMs: number; // WORKER_BACKOFF_BASE_MS
  prefix?: string; // prefijo de claves en Redis (los tests usan uno propio)
}

// Las colas no cierran la conexión que reciben: la cierra quien la creó
export class BullMqEmailQueue implements EmailQueue {
  private readonly queues: Record<TransportType, Queue<EmailJobData>>;

  constructor(connection: ConnectionOptions, settings: EmailQueueSettings) {
    const createQueue = (name: string) =>
      new Queue<EmailJobData>(name, {
        connection,
        ...(settings.prefix !== undefined && { prefix: settings.prefix }),
        defaultJobOptions: {
          attempts: settings.maxAttempts,
          // Espera base·2^(n-1), recortada al azar hasta un 50 % para no reintentar en bloque
          backoff: { type: 'exponential', delay: settings.backoffBaseMs, jitter: BACKOFF_JITTER },
          // La base de datos es la fuente de verdad; además, al borrar el job se puede volver
          // a encolar el mismo messageId (barrido, idempotencia)
          removeOnComplete: true,
          removeOnFail: true,
        },
      });
    this.queues = {
      api: createQueue(EMAIL_QUEUE_BY_TRANSPORT.api),
      smtp: createQueue(EMAIL_QUEUE_BY_TRANSPORT.smtp),
    };
  }

  async enqueue(messageId: string, transport: TransportType): Promise<void> {
    await this.queues[transport].add('send', { messageId }, { jobId: messageId });
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}
