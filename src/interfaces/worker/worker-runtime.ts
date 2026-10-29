import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Logger } from '../../application/ports/logger';
import type { ProcessEmailJob } from '../../application/process-email-job';
import type { TransportType } from '../../domain/email';
import {
  EMAIL_QUEUE_BY_TRANSPORT,
  MAINTENANCE_JOBS,
  MAINTENANCE_QUEUE,
  type EmailJobData,
} from '../../infrastructure/queue/queue-names';
import { createEmailProcessor } from './email-consumer';
import { createMaintenanceProcessor, type MaintenanceUseCases } from './maintenance-consumer';

// Un job por intervalo: sin limpieza, Redis acumularía uno por barrido para siempre. Se guardan
// los últimos fallidos para diagnosticarlos
const MAINTENANCE_JOB_OPTIONS = { removeOnComplete: true, removeOnFail: { count: 100 } };

export interface WorkerRuntimeOptions {
  connection: ConnectionOptions; // con maxRetriesPerRequest: null, como exige BullMQ
  prefix?: string;
  queues: readonly TransportType[]; // WORKER_QUEUES
  concurrency: Record<TransportType, number>;
  apiRateLimitPerSecond: number;
  sweepIntervalMs: number;
  retentionIntervalMs: number;
  processEmailJob: ProcessEmailJob;
  maintenance: MaintenanceUseCases;
  logger: Logger;
}

// Consumidores de BullMQ del proceso worker: las colas de email indicadas en WORKER_QUEUES y,
// siempre, la de mantenimiento
export class WorkerRuntime {
  private readonly workers: Worker[] = [];
  private maintenanceQueue: Queue | null = null;

  constructor(private readonly options: WorkerRuntimeOptions) {}

  async start(): Promise<void> {
    const { queues, processEmailJob, maintenance } = this.options;
    const processEmail = createEmailProcessor(processEmailJob);
    for (const transport of queues) {
      this.workers.push(
        this.createWorker<EmailJobData>(EMAIL_QUEUE_BY_TRANSPORT[transport], processEmail, {
          concurrency: this.options.concurrency[transport],
          // Solo la cola api tiene límite global: el SMTP se limita por servidor en el pool (fase 4)
          ...(transport === 'api' && {
            limiter: { max: this.options.apiRateLimitPerSecond, duration: 1_000 },
          }),
        }),
      );
    }
    const maintenanceWorker = this.createWorker(
      MAINTENANCE_QUEUE,
      createMaintenanceProcessor(maintenance),
      {},
    );
    // Los envíos registran sus fallos en ProcessEmailJob; los de mantenimiento, aquí
    maintenanceWorker.on('failed', (job, error) =>
      this.options.logger.error({ err: error, job: job?.name }, 'Maintenance job failed'),
    );
    this.workers.push(maintenanceWorker);
    await this.scheduleMaintenance();
  }

  isRunning(): boolean {
    return this.workers.length > 0 && this.workers.every((worker) => worker.isRunning());
  }

  // Deja de aceptar jobs, espera a que terminen los activos y cierra las conexiones propias.
  // La conexión recibida en las opciones la cierra quien la creó
  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.maintenanceQueue?.close();
  }

  private createWorker<T>(
    name: string,
    processor: (job: Job<T>) => Promise<unknown>,
    options: { concurrency?: number; limiter?: { max: number; duration: number } },
  ): Worker {
    const worker = new Worker(name, processor, {
      connection: this.options.connection,
      ...(this.options.prefix !== undefined && { prefix: this.options.prefix }),
      ...options,
    });
    // Sin este listener, un error de conexión emitido por el worker tumbaría el proceso
    worker.on('error', (error) =>
      this.options.logger.error({ err: error, queue: name }, 'Worker error'),
    );
    return worker;
  }

  // Los job schedulers viven en Redis con un id fijo: aunque arranquen varias réplicas,
  // cada tarea se ejecuta una sola vez por intervalo
  private async scheduleMaintenance(): Promise<void> {
    this.maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: this.options.connection,
      ...(this.options.prefix !== undefined && { prefix: this.options.prefix }),
    });
    await this.maintenanceQueue.upsertJobScheduler(
      MAINTENANCE_JOBS.sweepPendingEmails,
      { every: this.options.sweepIntervalMs },
      { name: MAINTENANCE_JOBS.sweepPendingEmails, opts: MAINTENANCE_JOB_OPTIONS },
    );
    await this.maintenanceQueue.upsertJobScheduler(
      MAINTENANCE_JOBS.applyRetention,
      { every: this.options.retentionIntervalMs },
      { name: MAINTENANCE_JOBS.applyRetention, opts: MAINTENANCE_JOB_OPTIONS },
    );
  }
}
