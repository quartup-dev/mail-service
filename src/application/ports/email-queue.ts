import type { TransportType } from '../../domain/email';

export interface EmailQueue {
  // Encola en la cola del transporte (emails-api o emails-smtp).
  // Idempotente: si ya existe un job con jobId = messageId, no hace nada
  enqueue(messageId: string, transport: TransportType): Promise<void>;
  close(): Promise<void>;
}
