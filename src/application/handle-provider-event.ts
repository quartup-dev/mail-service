import type { RecipientStatus } from '../domain/email';
import type { ProviderEvent, ProviderEventType } from '../domain/events';
import type { Clock } from './ports/clock';
import type { EmailRepository, StoredEmail } from './ports/email-repository';
import type { SuppressionReason, SuppressionRepository } from './ports/suppression-repository';

const RECIPIENT_STATUS_BY_EVENT: Record<ProviderEventType, RecipientStatus | null> = {
  delivered: 'delivered',
  bounced: 'bounced',
  complained: 'complained',
  unsubscribed: 'unsubscribed',
  temporary_failure: null, // solo se registra
};

const SUPPRESSION_REASON_BY_EVENT: Partial<Record<ProviderEventType, SuppressionReason>> = {
  bounced: 'bounce',
  complained: 'complaint',
  unsubscribed: 'unsubscribe',
};

export interface HandleProviderEventDeps {
  emails: EmailRepository;
  suppressions: SuppressionRepository;
  clock: Clock;
}

export class HandleProviderEvent {
  constructor(private readonly deps: HandleProviderEventDeps) {}

  async execute(event: ProviderEvent): Promise<void> {
    const { emails, suppressions, clock } = this.deps;
    const recipient = event.recipient.toLowerCase();
    const email = await this.correlate(event);

    await emails.recordEvent({
      emailId: email?.id ?? null,
      recipient,
      provider: event.provider,
      type: event.type,
      raw: event.raw,
      occurredAt: event.occurredAt,
      receivedAt: clock.now(),
    });

    const status = RECIPIENT_STATUS_BY_EVENT[event.type];
    if (email && status) {
      await emails.advanceRecipientStatus(email.id, recipient, status, event.occurredAt);
    }

    // La supresión protege la cuenta del proveedor aunque el mensaje ya no exista
    const reason = SUPPRESSION_REASON_BY_EVENT[event.type];
    if (reason) await suppressions.add(recipient, reason, event.provider);
  }

  // Primero por el id interno que enviamos con el mensaje; si no viene, por el id del proveedor
  private async correlate(event: ProviderEvent): Promise<StoredEmail | null> {
    if (event.messageId) return this.deps.emails.findById(event.messageId);
    if (event.providerMessageId) {
      return this.deps.emails.findByProviderMessageId(event.provider, event.providerMessageId);
    }
    return null;
  }
}
