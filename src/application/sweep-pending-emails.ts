import type { Clock } from './ports/clock';
import type { EmailQueue } from './ports/email-queue';
import type { EmailRepository } from './ports/email-repository';

export interface SweepPendingEmailsDeps {
  emails: EmailRepository;
  queue: EmailQueue;
  clock: Clock;
  pendingMaxAgeMs: number; // PENDING_MAX_AGE_MS
  stalePendingAfterMs: number; // STALE_PENDING_AFTER_MS
  batchSize: number;
}

export interface SweepResult {
  expired: number;
  requeued: number;
}

export class SweepPendingEmails {
  constructor(private readonly deps: SweepPendingEmailsDeps) {}

  async execute(): Promise<SweepResult> {
    // Primero caducar: un mensaje caducado no debe volver a la cola
    const expired = await this.expireOldPending();
    const requeued = await this.requeueStalePending();
    return { expired, requeued };
  }

  // Ninguna credencial SMTP permanece más de PENDING_MAX_AGE_MS. Cada lote sale del filtro
  // al pasar a failed, así que se repite hasta que no quedan
  private async expireOldPending(): Promise<number> {
    const { emails, clock, pendingMaxAgeMs, batchSize } = this.deps;
    const createdBefore = new Date(clock.now().getTime() - pendingMaxAgeMs);
    let expired = 0;
    for (;;) {
      const batch = await emails.findPending({ createdBefore }, batchSize);
      for (const email of batch) {
        await emails.updateStatus(email.id, 'failed', {
          errorCode: 'EXPIRED',
          errorMessage: 'The message stayed pending longer than the maximum age',
          smtpConfigEncrypted: null,
        });
      }
      expired += batch.length;
      if (batch.length < batchSize) return expired;
    }
  }

  // Re-encolar es idempotente (jobId = messageId): si el job sigue en la cola no pasa nada; si se
  // perdió, se crea de nuevo. Encolar no cambia updated_at, así que se procesa un solo lote por
  // barrido y el resto queda para el siguiente
  private async requeueStalePending(): Promise<number> {
    const { emails, queue, clock, stalePendingAfterMs, batchSize } = this.deps;
    const updatedBefore = new Date(clock.now().getTime() - stalePendingAfterMs);
    const batch = await emails.findPending({ updatedBefore }, batchSize);
    for (const email of batch) await queue.enqueue(email.id, email.transport);
    return batch.length;
  }
}
