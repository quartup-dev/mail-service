import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EmailQueue } from '../../application/ports/email-queue';
import type { Logger } from '../../application/ports/logger';
import type { TransportType } from '../../domain/email';
import { EMAIL_QUEUE_BY_TRANSPORT, type EmailJobData } from './queue-names';

const BACKOFF_JITTER = 0.5;
const ENQUEUE_TIMEOUT_MS = 5_000;
// Conexión caída; mientras se establece por primera vez basta con el tiempo máximo
const DISCONNECTED = new Set(['reconnecting', 'close', 'end']);

export interface EmailQueueSettings {
  maxAttempts: number; // WORKER_MAX_ATTEMPTS
  backoffBaseMs: number; // WORKER_BACKOFF_BASE_MS
  prefix?: string; // prefijo de claves en Redis (los tests usan uno propio)
  logger?: Logger; // sin él, BullMQ escribe los errores de conexión en la consola
}

// Las colas no cierran la conexión que reciben: la cierra quien la creó
export class BullMqEmailQueue implements EmailQueue {
  private readonly queues: Record<TransportType, Queue<EmailJobData>>;

  constructor(
    private readonly connection: Redis,
    settings: EmailQueueSettings,
  ) {
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
    for (const queue of Object.values(this.queues)) {
      queue.on('error', (error) =>
        settings.logger?.warn({ err: error, queue: queue.name }, 'Email queue error'),
      );
    }
  }

  // BullMQ espera a que Redis esté disponible antes de añadir el job: sin estas comprobaciones,
  // una petición HTTP quedaría colgada mientras Redis no responda. Quien encola trata el error
  // (QueueEmail responde igualmente y el barrido encola el mensaje después)
  async enqueue(messageId: string, transport: TransportType): Promise<void> {
    if (DISCONNECTED.has(this.connection.status)) throw new Error('Redis is not available');
    await withTimeout(
      this.queues[transport].add('send', { messageId }, { jobId: messageId }),
      ENQUEUE_TIMEOUT_MS,
    );
  }

  async close(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}

function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
