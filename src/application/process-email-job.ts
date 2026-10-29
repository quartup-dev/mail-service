import {
  isFinalEmailStatus,
  recipientsOf,
  type EmailMessage,
  type SmtpServerConfig,
} from '../domain/email';
import type { Clock } from './ports/clock';
import type { EmailApiProvider } from './ports/email-api-provider';
import type { EmailRepository, StoredEmail } from './ports/email-repository';
import type { SecretBox } from './ports/secret-box';
import type { SendResult } from './ports/send-result';
import type { SmtpHostGuard } from './ports/smtp-host-guard';
import type { SmtpSender } from './ports/smtp-sender';
import type { SuppressionRepository } from './ports/suppression-repository';

export interface ProcessEmailJobDeps {
  emails: EmailRepository;
  suppressions: SuppressionRepository;
  apiProvider: EmailApiProvider | null; // null: transporte api deshabilitado
  smtpSender: SmtpSender;
  smtpHostGuard: SmtpHostGuard;
  secretBox: SecretBox;
  clock: Clock;
}

export interface ProcessEmailJobInput {
  messageId: string;
  attempt: number; // empieza en 1
  maxAttempts: number;
}

export class ProcessEmailJob {
  constructor(private readonly deps: ProcessEmailJobDeps) {}

  async execute(input: ProcessEmailJobInput): Promise<void> {
    const { emails, clock } = this.deps;
    const email = await emails.findById(input.messageId);
    // queued o sending continúan: sending indica que un worker anterior cayó a mitad de envío
    if (!email?.payload || isFinalEmailStatus(email.status)) return;
    const message = email.payload;

    await emails.updateStatus(email.id, 'sending');
    const startedAt = clock.now();
    const result = await this.send(email, message);
    await emails.recordAttempt(email.id, {
      attempt: input.attempt,
      transport: email.transport,
      provider: result.provider,
      outcome: 'success',
      code: null,
      message: null,
      durationMs: clock.now().getTime() - startedAt.getTime(),
      createdAt: clock.now(),
    });
    await emails.updateStatus(email.id, 'sent', {
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      sentAt: result.acceptedAt,
      smtpConfigEncrypted: null,
    });
    await emails.setRecipientStatuses(email.id, recipientOutcomes(message, result));
  }

  private async send(email: StoredEmail, message: EmailMessage): Promise<SendResult> {
    if (email.transport === 'smtp') return this.sendBySmtp(email, message);
    if (!this.deps.apiProvider) throw new Error('Not implemented');
    return this.deps.apiProvider.send(message);
  }

  private async sendBySmtp(email: StoredEmail, message: EmailMessage): Promise<SendResult> {
    const server = JSON.parse(
      this.deps.secretBox.decrypt(email.smtpConfigEncrypted ?? ''),
    ) as SmtpServerConfig;
    const { ip } = await this.deps.smtpHostGuard.resolveAndValidate(server.host, server.port);
    return this.deps.smtpSender.send(message, server, { ip });
  }
}

function recipientOutcomes(message: EmailMessage, result: SendResult) {
  const rejected = new Set(result.rejectedRecipients?.map((email) => email.toLowerCase()));
  return recipientsOf(message).map(({ email }) => ({
    email,
    status: rejected.has(email) ? ('rejected' as const) : ('accepted' as const),
  }));
}
