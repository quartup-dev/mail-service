import type { ProviderName } from '../../domain/email';

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface SuppressionEntry {
  email: string; // en minúsculas
  reason: SuppressionReason;
  source: ProviderName | 'cli';
  createdAt: Date;
}

export interface SuppressionRepository {
  findSuppressed(emails: string[]): Promise<Set<string>>; // una consulta para todos los destinatarios
  add(email: string, reason: SuppressionReason, source: ProviderName | 'cli'): Promise<void>;
  remove(email: string): Promise<void>;
  list(opts?: {
    reason?: SuppressionReason;
    limit?: number;
    offset?: number;
  }): Promise<SuppressionEntry[]>;
}
