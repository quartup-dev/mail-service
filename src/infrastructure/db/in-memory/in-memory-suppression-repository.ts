import type { Clock } from '../../../application/ports/clock';
import type {
  SuppressionEntry,
  SuppressionReason,
  SuppressionRepository,
} from '../../../application/ports/suppression-repository';
import type { ProviderName } from '../../../domain/email';

export class InMemorySuppressionRepository implements SuppressionRepository {
  private readonly entries = new Map<string, SuppressionEntry>();

  constructor(private readonly clock: Clock) {}

  async findSuppressed(emails: string[]): Promise<Set<string>> {
    return new Set(
      emails.map((email) => email.toLowerCase()).filter((email) => this.entries.has(email)),
    );
  }

  async add(email: string, reason: SuppressionReason, source: ProviderName | 'cli'): Promise<void> {
    const normalized = email.toLowerCase();
    if (this.entries.has(normalized)) return;
    this.entries.set(normalized, {
      email: normalized,
      reason,
      source,
      createdAt: this.clock.now(),
    });
  }

  async remove(email: string): Promise<void> {
    this.entries.delete(email.toLowerCase());
  }

  async list(
    opts: { reason?: SuppressionReason; limit?: number; offset?: number } = {},
  ): Promise<SuppressionEntry[]> {
    const { reason, limit = Number.POSITIVE_INFINITY, offset = 0 } = opts;
    return [...this.entries.values()]
      .filter((entry) => !reason || entry.reason === reason)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(offset, offset + limit)
      .map((entry) => ({ ...entry, createdAt: new Date(entry.createdAt) }));
  }
}
