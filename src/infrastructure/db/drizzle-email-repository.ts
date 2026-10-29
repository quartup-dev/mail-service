import { and, asc, eq, inArray, isNotNull, lt, type SQL } from 'drizzle-orm';
import type { Clock } from '../../application/ports/clock';
import type {
  AttemptRecord,
  CreateEmailInput,
  EmailRepository,
  EmailStatusPatch,
  StoredEmail,
  StoredEvent,
} from '../../application/ports/email-repository';
import {
  FINAL_EMAIL_STATUSES,
  recipientsOf,
  recipientStatusRank,
  type EmailStatus,
  type ProviderName,
  type RecipientStatus,
} from '../../domain/email';
import type { Database } from './client';
import { emailAttempts, emailEvents, emailRecipients, emails } from './schema';

const PENDING_STATUSES: EmailStatus[] = ['queued', 'sending'];
const FINAL_STATUSES: EmailStatus[] = [...FINAL_EMAIL_STATUSES];

type EmailRow = typeof emails.$inferSelect;

export class DrizzleEmailRepository implements EmailRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  // ON CONFLICT DO NOTHING sobre (client_id, idempotency_key): con peticiones simultáneas,
  // la segunda espera a que la primera confirme y no inserta nada
  async create(input: CreateEmailInput): Promise<{ email: StoredEmail; created: boolean }> {
    const { message } = input;
    const now = this.clock.now();
    const smtp = message.transport.type === 'smtp' ? message.transport.smtp : null;

    const created = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(emails)
        .values({
          id: message.id,
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey ?? null,
          requestHash: input.requestHash,
          requestId: input.requestId,
          payload: message,
          transport: message.transport.type,
          smtpHost: smtp?.host ?? null,
          smtpPort: smtp?.port ?? null,
          smtpConfigEncrypted: input.smtpConfigEncrypted ?? null,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [emails.clientId, emails.idempotencyKey] })
        .returning({ id: emails.id });
      if (inserted.length === 0) return false;

      await tx.insert(emailRecipients).values(
        recipientsOf(message).map((recipient, position) => ({
          emailId: message.id,
          email: recipient.email,
          kind: recipient.kind,
          position,
          status: 'pending' as const,
          statusRank: recipientStatusRank('pending'),
          updatedAt: now,
        })),
      );
      return true;
    });

    const email = created
      ? await this.findById(message.id)
      : await this.findOne(
          and(
            eq(emails.clientId, input.clientId),
            eq(emails.idempotencyKey, input.idempotencyKey ?? ''),
          ),
        );
    if (!email) throw new Error(`Email ${message.id} not found right after creating it`);
    return { email, created };
  }

  findById(id: string): Promise<StoredEmail | null> {
    return this.findOne(eq(emails.id, id));
  }

  findByProviderMessageId(
    provider: ProviderName,
    providerMessageId: string,
  ): Promise<StoredEmail | null> {
    return this.findOne(
      and(eq(emails.provider, provider), eq(emails.providerMessageId, providerMessageId)),
    );
  }

  async updateStatus(id: string, status: EmailStatus, patch: EmailStatusPatch = {}): Promise<void> {
    await this.db
      .update(emails)
      .set({ ...patch, status, updatedAt: this.clock.now() })
      .where(eq(emails.id, id));
  }

  async recordAttempt(id: string, attempt: AttemptRecord): Promise<void> {
    await this.db.insert(emailAttempts).values({ emailId: id, ...attempt });
  }

  async setRecipientStatuses(
    id: string,
    updates: Array<{ email: string; status: RecipientStatus }>,
  ): Promise<void> {
    const now = this.clock.now();
    for (const { email, status } of updates) await this.advance(id, email, status, now);
  }

  advanceRecipientStatus(
    id: string,
    email: string,
    status: RecipientStatus,
    occurredAt: Date,
  ): Promise<boolean> {
    return this.advance(id, email, status, occurredAt);
  }

  async findPending(
    filter: { createdBefore?: Date; updatedBefore?: Date },
    limit: number,
  ): Promise<StoredEmail[]> {
    const rows = await this.db
      .select()
      .from(emails)
      .where(
        and(
          inArray(emails.status, PENDING_STATUSES),
          filter.createdBefore && lt(emails.createdAt, filter.createdBefore),
          filter.updatedBefore && lt(emails.updatedAt, filter.updatedBefore),
        ),
      )
      .orderBy(asc(emails.createdAt))
      .limit(limit);
    return this.withChildren(rows);
  }

  async recordEvent(event: StoredEvent): Promise<void> {
    await this.db.insert(emailEvents).values(event);
  }

  async clearPayloads(finalBefore: Date, limit: number): Promise<number> {
    const expired = this.db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          inArray(emails.status, FINAL_STATUSES),
          isNotNull(emails.payload),
          lt(emails.updatedAt, finalBefore),
        ),
      )
      .limit(limit);
    const cleared = await this.db
      .update(emails)
      .set({ payload: null })
      .where(inArray(emails.id, expired))
      .returning({ id: emails.id });
    return cleared.length;
  }

  async deleteEvents(receivedBefore: Date, limit: number): Promise<number> {
    const expired = this.db
      .select({ id: emailEvents.id })
      .from(emailEvents)
      .where(lt(emailEvents.receivedAt, receivedBefore))
      .limit(limit);
    const deleted = await this.db
      .delete(emailEvents)
      .where(inArray(emailEvents.id, expired))
      .returning({ id: emailEvents.id });
    return deleted.length;
  }

  // Destinatarios, intentos y eventos se borran en cascada
  async deleteFinalEmails(createdBefore: Date, limit: number): Promise<number> {
    const expired = this.db
      .select({ id: emails.id })
      .from(emails)
      .where(and(inArray(emails.status, FINAL_STATUSES), lt(emails.createdAt, createdBefore)))
      .limit(limit);
    const deleted = await this.db
      .delete(emails)
      .where(inArray(emails.id, expired))
      .returning({ id: emails.id });
    return deleted.length;
  }

  // Transición atómica: solo se aplica si el rango nuevo es mayor que el guardado
  private async advance(
    id: string,
    email: string,
    status: RecipientStatus,
    at: Date,
  ): Promise<boolean> {
    const rank = recipientStatusRank(status);
    const updated = await this.db
      .update(emailRecipients)
      .set({ status, statusRank: rank, updatedAt: at })
      .where(
        and(
          eq(emailRecipients.emailId, id),
          eq(emailRecipients.email, email),
          lt(emailRecipients.statusRank, rank),
        ),
      )
      .returning({ email: emailRecipients.email });
    return updated.length > 0;
  }

  private async findOne(condition: SQL | undefined): Promise<StoredEmail | null> {
    const rows = await this.db.select().from(emails).where(condition).limit(1);
    const [email] = await this.withChildren(rows);
    return email ?? null;
  }

  // Carga destinatarios e intentos de todos los mensajes con una consulta por tabla
  private async withChildren(rows: EmailRow[]): Promise<StoredEmail[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [recipients, attempts] = await Promise.all([
      this.db
        .select()
        .from(emailRecipients)
        .where(inArray(emailRecipients.emailId, ids))
        .orderBy(asc(emailRecipients.position)),
      this.db
        .select()
        .from(emailAttempts)
        .where(inArray(emailAttempts.emailId, ids))
        .orderBy(asc(emailAttempts.id)),
    ]);

    return rows.map((row) => ({
      ...row,
      recipients: recipients
        .filter((recipient) => recipient.emailId === row.id)
        .map(({ email, kind, status, updatedAt }) => ({ email, kind, status, updatedAt })),
      attempts: attempts
        .filter((attempt) => attempt.emailId === row.id)
        .map(({ attempt, transport, provider, outcome, code, message, durationMs, createdAt }) => ({
          attempt,
          transport,
          provider,
          outcome,
          code,
          message,
          durationMs,
          createdAt,
        })),
    }));
  }
}
