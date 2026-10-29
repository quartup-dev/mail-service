import {
  isFinalEmailStatus,
  recipientsOf,
  type Address,
  type EmailMessage,
  type ProviderName,
  type SmtpServerConfig,
} from '../domain/email';
import {
  EmailRequestRejectedError,
  PermanentProviderError,
  ProviderError,
  SmtpHostNotAllowedError,
  UndecryptableSecretError,
} from '../domain/errors';
import type { Clock } from './ports/clock';
import type { EmailApiProvider } from './ports/email-api-provider';
import type { AttemptRecord, EmailRepository, StoredEmail } from './ports/email-repository';
import type { Logger } from './ports/logger';
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
  logger: Logger;
}

export interface ProcessEmailJobInput {
  messageId: string;
  attempt: number; // empieza en 1
  maxAttempts: number;
}

type AttemptOutcome = Pick<AttemptRecord, 'provider' | 'outcome' | 'code' | 'message'>;

export class ProcessEmailJob {
  constructor(private readonly deps: ProcessEmailJobDeps) {}

  async execute(input: ProcessEmailJobInput): Promise<void> {
    const { emails } = this.deps;
    const email = await emails.findById(input.messageId);
    // queued o sending continúan: sending indica que un worker anterior cayó a mitad de envío
    if (!email?.payload || isFinalEmailStatus(email.status)) return;

    if (email.transport === 'api' && !this.deps.apiProvider) {
      const error = new EmailRequestRejectedError(
        'API_TRANSPORT_NOT_CONFIGURED',
        'The api transport is not configured',
      );
      await this.fail(email, error.code, error.message);
      throw error;
    }

    const message =
      email.transport === 'api'
        ? await this.withoutSuppressed(email, email.payload)
        : email.payload;
    if (!message) return;

    await emails.updateStatus(email.id, 'sending');
    const startedAt = this.deps.clock.now();
    let result: SendResult;
    try {
      result = await this.send(email, message);
    } catch (error) {
      await this.recordFailure(email, input, startedAt, error);
      throw error;
    }

    await this.recordAttempt(email, input, startedAt, {
      provider: result.provider,
      outcome: 'success',
      code: null,
      message: null,
    });
    await emails.updateStatus(email.id, 'sent', {
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      sentAt: result.acceptedAt,
      smtpConfigEncrypted: null,
    });
    await emails.setRecipientStatuses(email.id, recipientOutcomes(message, result));
    this.deps.logger.info(logContext(email, input, result.provider), 'Email sent');
  }

  // Solo con api: la supresión es global y protege la reputación de la cuenta del proveedor.
  // Devuelve el mensaje sin los suprimidos, o null si no queda ningún destinatario
  private async withoutSuppressed(
    email: StoredEmail,
    message: EmailMessage,
  ): Promise<EmailMessage | null> {
    const recipients = recipientsOf(message);
    const suppressed = await this.deps.suppressions.findSuppressed(recipients.map((r) => r.email));
    if (suppressed.size === 0) return message;

    await this.deps.emails.setRecipientStatuses(
      email.id,
      [...suppressed].map((address) => ({ email: address, status: 'suppressed' as const })),
    );
    if (recipients.every((recipient) => suppressed.has(recipient.email))) {
      await this.deps.emails.updateStatus(email.id, 'suppressed');
      return null;
    }

    const notSuppressed = (addresses: Address[] = []) =>
      addresses.filter((address) => !suppressed.has(address.email.toLowerCase()));
    return {
      ...message,
      to: notSuppressed(message.to),
      cc: notSuppressed(message.cc),
      bcc: notSuppressed(message.bcc),
    };
  }

  private async send(email: StoredEmail, message: EmailMessage): Promise<SendResult> {
    if (email.transport === 'smtp') return this.sendBySmtp(email, message);
    // execute() ya ha comprobado que hay proveedor para los mensajes api
    return (this.deps.apiProvider as EmailApiProvider).send(message);
  }

  private async sendBySmtp(email: StoredEmail, message: EmailMessage): Promise<SendResult> {
    const server = this.decryptSmtpConfig(email);
    const { ip } = await this.validateSmtpHost(server);
    return this.deps.smtpSender.send(message, server, { ip });
  }

  private decryptSmtpConfig(email: StoredEmail): SmtpServerConfig {
    try {
      return JSON.parse(
        this.deps.secretBox.decrypt(email.smtpConfigEncrypted ?? ''),
      ) as SmtpServerConfig;
    } catch (error) {
      if (!(error instanceof UndecryptableSecretError)) throw error;
      throw new PermanentProviderError(error.message, 'smtp', 'SMTP_CONFIG_UNDECRYPTABLE', {
        cause: error,
      });
    }
  }

  // El DNS puede haber cambiado desde que la API validó el host: se valida otra vez
  private async validateSmtpHost(server: SmtpServerConfig): Promise<{ ip: string }> {
    try {
      return await this.deps.smtpHostGuard.resolveAndValidate(server.host, server.port);
    } catch (error) {
      if (!(error instanceof SmtpHostNotAllowedError)) throw error;
      throw new PermanentProviderError(error.message, 'smtp', 'SMTP_HOST_NOT_ALLOWED', {
        cause: error,
      });
    }
  }

  // Permanente o último intento: failed. Transitorio (o sin clasificar) con intentos restantes:
  // vuelve a queued. En ambos casos el llamador relanza el error: la cola reintenta o registra
  // el job como fallido (el consumidor convierte los permanentes en UnrecoverableError)
  private async recordFailure(
    email: StoredEmail,
    input: ProcessEmailJobInput,
    startedAt: Date,
    error: unknown,
  ): Promise<void> {
    const permanent = error instanceof PermanentProviderError;
    const willRetry = !permanent && input.attempt < input.maxAttempts;
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    const provider = error instanceof ProviderError ? error.provider : this.providerOf(email);
    await this.recordAttempt(email, input, startedAt, {
      provider,
      outcome: permanent ? 'permanent_error' : 'transient_error',
      code,
      message,
    });
    this.deps.logger.warn(
      { ...logContext(email, input, provider), errorCode: code, willRetry },
      'Email send attempt failed',
    );

    if (!willRetry) {
      await this.fail(email, code, message);
    } else {
      await this.deps.emails.updateStatus(email.id, 'queued');
    }
  }

  // Estado final: la configuración SMTP cifrada se borra
  private async fail(email: StoredEmail, errorCode: string, errorMessage: string): Promise<void> {
    await this.deps.emails.updateStatus(email.id, 'failed', {
      errorCode,
      errorMessage,
      smtpConfigEncrypted: null,
    });
  }

  private async recordAttempt(
    email: StoredEmail,
    input: ProcessEmailJobInput,
    startedAt: Date,
    outcome: AttemptOutcome,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.emails.recordAttempt(email.id, {
      attempt: input.attempt,
      transport: email.transport,
      ...outcome,
      durationMs: now.getTime() - startedAt.getTime(),
      createdAt: now,
    });
  }

  private providerOf(email: StoredEmail) {
    return email.transport === 'smtp' ? 'smtp' : (this.deps.apiProvider?.name ?? null);
  }
}

// requestId enlaza los logs del worker con la petición HTTP que creó el mensaje.
// Las direcciones de correo no se registran (solo en debug, según CLAUDE.md)
function logContext(
  email: StoredEmail,
  input: ProcessEmailJobInput,
  provider: ProviderName | null,
) {
  return {
    messageId: email.id,
    clientId: email.clientId,
    requestId: email.requestId,
    transport: email.transport,
    provider,
    attempt: input.attempt,
  };
}

function errorCodeOf(error: unknown): string {
  if (!(error instanceof ProviderError)) return 'UNEXPECTED_ERROR';
  return error.code ?? 'PROVIDER_ERROR';
}

function recipientOutcomes(message: EmailMessage, result: SendResult) {
  const rejected = new Set(result.rejectedRecipients?.map((email) => email.toLowerCase()));
  return recipientsOf(message).map(({ email }) => ({
    email,
    status: rejected.has(email) ? ('rejected' as const) : ('accepted' as const),
  }));
}
