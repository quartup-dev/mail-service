import type { Clock } from './ports/clock';
import type { EmailRepository } from './ports/email-repository';

const DAY_MS = 86_400_000;

export interface ApplyRetentionDeps {
  emails: EmailRepository;
  clock: Clock;
  payloadRetentionDays: number; // PAYLOAD_RETENTION_DAYS
  eventsRetentionDays: number; // EVENTS_RETENTION_DAYS
  messageRetentionDays: number; // MESSAGE_RETENTION_DAYS
  batchSize: number;
}

export interface RetentionResult {
  payloadsCleared: number;
  eventsDeleted: number;
  emailsDeleted: number;
}

export class ApplyRetention {
  constructor(private readonly deps: ApplyRetentionDeps) {}

  // Nunca toca mensajes pendientes ni la tabla de supresiones
  async execute(): Promise<RetentionResult> {
    const { emails } = this.deps;
    const payloadsBefore = this.daysAgo(this.deps.payloadRetentionDays);
    const eventsBefore = this.daysAgo(this.deps.eventsRetentionDays);
    const emailsBefore = this.daysAgo(this.deps.messageRetentionDays);
    return {
      payloadsCleared: await this.inBatches((limit) => emails.clearPayloads(payloadsBefore, limit)),
      eventsDeleted: await this.inBatches((limit) => emails.deleteEvents(eventsBefore, limit)),
      emailsDeleted: await this.inBatches((limit) => emails.deleteFinalEmails(emailsBefore, limit)),
    };
  }

  // Repite la sentencia hasta que afecta a menos filas que el tamaño de lote
  private async inBatches(step: (limit: number) => Promise<number>): Promise<number> {
    const { batchSize } = this.deps;
    let total = 0;
    for (;;) {
      const affected = await step(batchSize);
      total += affected;
      if (affected < batchSize) return total;
    }
  }

  private daysAgo(days: number): Date {
    return new Date(this.deps.clock.now().getTime() - days * DAY_MS);
  }
}
