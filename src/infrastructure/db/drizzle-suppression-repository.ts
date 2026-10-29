import { asc, eq, inArray } from 'drizzle-orm';
import type { Clock } from '../../application/ports/clock';
import type {
  SuppressionEntry,
  SuppressionReason,
  SuppressionRepository,
} from '../../application/ports/suppression-repository';
import type { ProviderName } from '../../domain/email';
import type { Database } from './client';
import { suppressions } from './schema';

export class DrizzleSuppressionRepository implements SuppressionRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async findSuppressed(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows = await this.db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(
        inArray(
          suppressions.email,
          emails.map((email) => email.toLowerCase()),
        ),
      );
    return new Set(rows.map((row) => row.email));
  }

  // Si ya existe, se conserva la entrada original
  async add(email: string, reason: SuppressionReason, source: ProviderName | 'cli'): Promise<void> {
    await this.db
      .insert(suppressions)
      .values({ email: email.toLowerCase(), reason, source, createdAt: this.clock.now() })
      .onConflictDoNothing({ target: suppressions.email });
  }

  async remove(email: string): Promise<void> {
    await this.db.delete(suppressions).where(eq(suppressions.email, email.toLowerCase()));
  }

  async list(
    opts: { reason?: SuppressionReason; limit?: number; offset?: number } = {},
  ): Promise<SuppressionEntry[]> {
    const query = this.db
      .select()
      .from(suppressions)
      .where(opts.reason && eq(suppressions.reason, opts.reason))
      .orderBy(asc(suppressions.createdAt), asc(suppressions.email))
      .offset(opts.offset ?? 0);
    return opts.limit === undefined ? query : query.limit(opts.limit);
  }
}
