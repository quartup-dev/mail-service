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
  recipientsOf,
  type EmailStatus,
  type ProviderName,
  type RecipientStatus,
} from '../../../domain/email';

const notImplemented = () => Promise.reject(new Error('Not implemented'));

export class InMemoryEmailRepository implements EmailRepository {
  private readonly emails = new Map<string, StoredEmail>();

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
  findByProviderMessageId(_p: ProviderName, _id: string): Promise<StoredEmail | null> {
    return notImplemented();
  }
  updateStatus(_id: string, _status: EmailStatus, _patch?: EmailStatusPatch): Promise<void> {
    return notImplemented();
  }
  recordAttempt(_id: string, _attempt: AttemptRecord): Promise<void> {
    return notImplemented();
  }
  setRecipientStatuses(
    _id: string,
    _updates: Array<{ email: string; status: RecipientStatus }>,
  ): Promise<void> {
    return notImplemented();
  }
  advanceRecipientStatus(
    _id: string,
    _email: string,
    _status: RecipientStatus,
    _occurredAt: Date,
  ): Promise<boolean> {
    return notImplemented();
  }
  findPending(
    _filter: { createdBefore?: Date; updatedBefore?: Date },
    _limit: number,
  ): Promise<StoredEmail[]> {
    return notImplemented();
  }
  recordEvent(_event: StoredEvent): Promise<void> {
    return notImplemented();
  }
  clearPayloads(_finalBefore: Date, _limit: number): Promise<number> {
    return notImplemented();
  }
  deleteEvents(_receivedBefore: Date, _limit: number): Promise<number> {
    return notImplemented();
  }
  deleteFinalEmails(_createdBefore: Date, _limit: number): Promise<number> {
    return notImplemented();
  }
}
