import type { ApiClient } from './ports/api-client-repository';
import type { EmailQueue } from './ports/email-queue';
import type { EmailRepository, StoredEmail } from './ports/email-repository';
import type { IdGenerator } from './ports/id-generator';
import type { Logger } from './ports/logger';
import type { SecretBox } from './ports/secret-box';
import type { SmtpHostGuard } from './ports/smtp-host-guard';
import {
  isFinalEmailStatus,
  type ApiProviderName,
  type EmailRequest,
  type SmtpServerConfig,
  type TransportSpec,
} from '../domain/email';
import { matchesDomainPattern } from '../domain/domain-pattern';
import { EmailRequestRejectedError } from '../domain/errors';
import { computeRequestHash } from './request-hash';

export interface QueueEmailDeps {
  emails: EmailRepository;
  queue: EmailQueue;
  smtpHostGuard: SmtpHostGuard;
  secretBox: SecretBox;
  ids: IdGenerator;
  logger: Logger;
  apiProviderName: ApiProviderName | null; // null: transporte api deshabilitado
  allowedFromDomains: string[]; // ALLOWED_FROM_DOMAINS, si el cliente no define los suyos
  requestHashPepper: Buffer;
}

export interface QueueEmailInput {
  client: ApiClient;
  request: EmailRequest;
  requestId: string;
  idempotencyKey?: string;
}

export interface QueueEmailResult {
  email: StoredEmail;
  created: boolean;
}

interface ProtectedTransport {
  transport: TransportSpec;
  smtpConfigEncrypted?: string;
}

export class QueueEmail {
  constructor(private readonly deps: QueueEmailDeps) {}

  async execute(input: QueueEmailInput): Promise<QueueEmailResult> {
    const { client, request } = input;
    this.ensureTransportAllowed(client, request);
    const { transport, smtpConfigEncrypted } =
      request.transport.type === 'smtp'
        ? await this.protectSmtpConfig(request.transport.smtp)
        : this.checkApiTransport(client, request);

    const requestHash = computeRequestHash(request, this.deps.requestHashPepper);
    const { email, created } = await this.deps.emails.create({
      message: { ...request, transport, id: this.deps.ids.next() },
      clientId: client.id,
      requestId: input.requestId,
      requestHash,
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      ...(smtpConfigEncrypted !== undefined && { smtpConfigEncrypted }),
    });
    if (!created && email.requestHash !== requestHash) {
      throw new EmailRequestRejectedError(
        'IDEMPOTENCY_CONFLICT',
        'The idempotency key was already used with a different request body',
      );
    }

    // Re-encolar un pendiente es seguro: el job usa jobId = messageId
    if (!isFinalEmailStatus(email.status)) await this.enqueue(email);
    return { email, created };
  }

  // Si la cola falla, el mensaje ya está guardado y el barrido lo encolará
  private async enqueue(email: StoredEmail): Promise<void> {
    try {
      await this.deps.queue.enqueue(email.id, email.transport);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, messageId: email.id, clientId: email.clientId },
        'Could not enqueue the email; the sweep will enqueue it later',
      );
    }
  }

  private ensureTransportAllowed(client: ApiClient, request: EmailRequest): void {
    if (!client.allowedTransports.includes(request.transport.type)) {
      throw new EmailRequestRejectedError(
        'TRANSPORT_NOT_ALLOWED',
        `Client ${client.id} cannot use the ${request.transport.type} transport`,
      );
    }
  }

  // Valida el host y separa los secretos: el payload solo guarda host y puerto, y la
  // configuración completa (credenciales y DKIM incluidas) se guarda cifrada
  private async protectSmtpConfig(smtp: SmtpServerConfig): Promise<ProtectedTransport> {
    await this.deps.smtpHostGuard.resolveAndValidate(smtp.host, smtp.port);
    return {
      transport: { type: 'smtp', smtp: { host: smtp.host, port: smtp.port } },
      smtpConfigEncrypted: this.deps.secretBox.encrypt(JSON.stringify(smtp)),
    };
  }

  private checkApiTransport(client: ApiClient, request: EmailRequest): ProtectedTransport {
    if (!this.deps.apiProviderName) {
      throw new EmailRequestRejectedError(
        'API_TRANSPORT_NOT_CONFIGURED',
        'The api transport is not configured',
      );
    }

    const fromDomain = domainOf(request.from.email);
    const allowedDomains = client.allowedFromDomains ?? this.deps.allowedFromDomains;
    if (!allowedDomains.some((pattern) => matchesDomainPattern(fromDomain, pattern))) {
      throw new EmailRequestRejectedError(
        'FROM_DOMAIN_NOT_ALLOWED',
        `The from domain ${fromDomain} is not allowed for client ${client.id}`,
      );
    }
    return { transport: request.transport };
  }
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}
