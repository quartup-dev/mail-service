import type { Clock } from '../../../application/ports/clock';
import type {
  AttemptRecord,
  CreateEmailInput,
  EmailRepository,
  EmailStatusPatch,
  StoredEmail,
  StoredEvent,
} from '../../../application/ports/email-repository';
import {
  canAdvanceRecipientStatus,
  FINAL_EMAIL_STATUSES,
  recipientsOf,
  type EmailStatus,
  type ProviderName,
  type RecipientStatus,
} from '../../../domain/email';

const PENDING_STATUSES: readonly EmailStatus[] = ['queued', 'sending'];

export class InMemoryEmailRepository implements EmailRepository {
  private readonly emails = new Map<string, StoredEmail>();
  private events: StoredEvent[] = [];

  constructor(private readonly clock: Clock) {}

  async create(input: CreateEmailInput): Promise<{ email: StoredEmail; created: boolean }> {
    const existing = this.findByIdempotencyKey(input.clientId, input.idempotencyKey);
    if (existing) return { email: structuredClone(existing), created: false };

    const now = this.clock.now();
    const { message } = input;
    const smtp = message.transport.type === 'smtp' ? message.transport.smtp : null;
    const email: StoredEmail = {
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
      provider: null,
      providerMessageId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      sentAt: null,
      recipients: recipientsOf(message).map((recipient) => ({
        ...recipient,
        status: 'pending',
        updatedAt: now,
      })),
      attempts: [],
    };
    this.emails.set(email.id, structuredClone(email));
    return { email: structuredClone(email), created: true };
  }

  private findByIdempotencyKey(clientId: string, key: string | undefined): StoredEmail | undefined {
    if (key === undefined) return undefined;
    return [...this.emails.values()].find(
      (email) => email.clientId === clientId && email.idempotencyKey === key,
    );
  }

  async findById(id: string): Promise<StoredEmail | null> {
    const email = this.emails.get(id);
    return email ? structuredClone(email) : null;
  }
  async findByProviderMessageId(
    provider: ProviderName,
    providerMessageId: string,
  ): Promise<StoredEmail | null> {
    const email = [...this.emails.values()].find(
      (candidate) =>
        candidate.provider === provider && candidate.providerMessageId === providerMessageId,
    );
    return email ? structuredClone(email) : null;
  }

  async updateStatus(id: string, status: EmailStatus, patch: EmailStatusPatch = {}): Promise<void> {
    const email = this.emails.get(id);
    if (!email) return;
    Object.assign(email, structuredClone(patch), { status, updatedAt: this.clock.now() });
  }

  async recordAttempt(id: string, attempt: AttemptRecord): Promise<void> {
    this.emails.get(id)?.attempts.push(structuredClone(attempt));
  }
  async setRecipientStatuses(
    id: string,
    updates: Array<{ email: string; status: RecipientStatus }>,
  ): Promise<void> {
    const now = this.clock.now();
    for (const { email, status } of updates) this.advance(id, email, status, now);
  }

  async advanceRecipientStatus(
    id: string,
    email: string,
    status: RecipientStatus,
    occurredAt: Date,
  ): Promise<boolean> {
    return this.advance(id, email, status, occurredAt);
  }

  private advance(id: string, email: string, status: RecipientStatus, at: Date): boolean {
    const recipient = this.emails.get(id)?.recipients.find((r) => r.email === email);
    if (!recipient || !canAdvanceRecipientStatus(recipient.status, status)) return false;
    recipient.status = status;
    recipient.updatedAt = new Date(at);
    return true;
  }

  async findPending(
    filter: { createdBefore?: Date; updatedBefore?: Date },
    limit: number,
  ): Promise<StoredEmail[]> {
    const { createdBefore, updatedBefore } = filter;
    return [...this.emails.values()]
      .filter((email) => PENDING_STATUSES.includes(email.status))
      .filter((email) => !createdBefore || email.createdAt < createdBefore)
      .filter((email) => !updatedBefore || email.updatedAt < updatedBefore)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((email) => structuredClone(email));
  }
  async recordEvent(event: StoredEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async clearPayloads(finalBefore: Date, limit: number): Promise<number> {
    const expired = [...this.emails.values()]
      .filter((email) => isFinal(email) && email.payload !== null && email.updatedAt < finalBefore)
      .slice(0, limit);
    for (const email of expired) email.payload = null;
    return expired.length;
  }

  async deleteEvents(receivedBefore: Date, limit: number): Promise<number> {
    const expired = new Set(
      this.events.filter((event) => event.receivedAt < receivedBefore).slice(0, limit),
    );
    this.events = this.events.filter((event) => !expired.has(event));
    return expired.size;
  }

  async deleteFinalEmails(createdBefore: Date, limit: number): Promise<number> {
    const expired = [...this.emails.values()]
      .filter((email) => isFinal(email) && email.createdAt < createdBefore)
      .slice(0, limit);
    const expiredIds = new Set(expired.map((email) => email.id));
    for (const id of expiredIds) this.emails.delete(id);
    this.events = this.events.filter((event) => !event.emailId || !expiredIds.has(event.emailId));
    return expired.length;
  }
}

function isFinal(email: StoredEmail): boolean {
  return FINAL_EMAIL_STATUSES.includes(email.status);
}
