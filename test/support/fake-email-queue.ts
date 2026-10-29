import type { EmailQueue } from '../../src/application/ports/email-queue';
import type { TransportType } from '../../src/domain/email';

// Cola idempotente por messageId, como BullMQ con jobId = messageId
export class FakeEmailQueue implements EmailQueue {
  readonly jobs = new Map<string, TransportType>();
  enqueueCalls = 0;
  private failure: Error | null = null;

  async enqueue(messageId: string, transport: TransportType): Promise<void> {
    this.enqueueCalls++;
    if (this.failure) throw this.failure;
    if (!this.jobs.has(messageId)) this.jobs.set(messageId, transport);
  }

  async close(): Promise<void> {}

  failWith(error: Error): void {
    this.failure = error;
  }

  // Simula que el worker toma el job
  take(messageId: string): void {
    this.jobs.delete(messageId);
  }
}
