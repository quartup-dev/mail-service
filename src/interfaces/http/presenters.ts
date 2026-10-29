import type { StoredEmail } from '../../application/ports/email-repository';
import type { RecipientStatus } from '../../domain/email';

export function toEmailAccepted(email: StoredEmail) {
  return { id: email.id, status: email.status, transport: email.transport };
}

// Nunca incluye la configuración SMTP cifrada: como mucho host y puerto
export function toEmailStatusResponse(email: StoredEmail) {
  return {
    id: email.id,
    status: email.status,
    transport: email.transport,
    provider: email.provider,
    providerMessageId: email.providerMessageId,
    smtp:
      email.smtpHost !== null && email.smtpPort !== null
        ? { host: email.smtpHost, port: email.smtpPort }
        : null,
    errorCode: email.errorCode,
    errorMessage: email.errorMessage,
    recipients: email.recipients.map((recipient) => ({
      email: recipient.email,
      kind: recipient.kind,
      status: recipient.status,
      updatedAt: recipient.updatedAt.toISOString(),
    })),
    deliverySummary: deliverySummaryOf(email.recipients.map((recipient) => recipient.status)),
    attempts: email.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      transport: attempt.transport,
      provider: attempt.provider,
      outcome: attempt.outcome,
      code: attempt.code,
      message: attempt.message,
      durationMs: attempt.durationMs,
      createdAt: attempt.createdAt.toISOString(),
    })),
    createdAt: email.createdAt.toISOString(),
    updatedAt: email.updatedAt.toISOString(),
    sentAt: email.sentAt?.toISOString() ?? null,
  };
}

function deliverySummaryOf(statuses: RecipientStatus[]): Partial<Record<RecipientStatus, number>> {
  const summary: Partial<Record<RecipientStatus, number>> = {};
  for (const status of statuses) summary[status] = (summary[status] ?? 0) + 1;
  return summary;
}
