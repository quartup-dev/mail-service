import type { ApiClient } from './ports/api-client-repository';
import type { EmailQueue } from './ports/email-queue';
import type { EmailRepository, StoredEmail } from './ports/email-repository';
import type { IdGenerator } from './ports/id-generator';
import type { Logger } from './ports/logger';
import type { SecretBox } from './ports/secret-box';
import type { SmtpHostGuard } from './ports/smtp-host-guard';
import type { ApiProviderName, EmailRequest } from '../domain/email';
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

export class QueueEmail {
  constructor(private readonly deps: QueueEmailDeps) {}

  async execute(input: QueueEmailInput): Promise<QueueEmailResult> {
    const { client, request } = input;
    this.ensureTransportAllowed(client, request);
    if (request.transport.type === 'api') this.ensureApiSendingAllowed(client, request);

    const { email, created } = await this.deps.emails.create({
      message: { ...request, id: this.deps.ids.next() },
      clientId: client.id,
      requestId: input.requestId,
      requestHash: computeRequestHash(request, this.deps.requestHashPepper),
      ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
    });
    await this.deps.queue.enqueue(email.id, email.transport);
    return { email, created };
  }

  private ensureTransportAllowed(client: ApiClient, request: EmailRequest): void {
    if (!client.allowedTransports.includes(request.transport.type)) {
      throw new EmailRequestRejectedError(
        'TRANSPORT_NOT_ALLOWED',
        `Client ${client.id} cannot use the ${request.transport.type} transport`,
      );
    }
  }

  private ensureApiSendingAllowed(client: ApiClient, request: EmailRequest): void {
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
  }
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}
