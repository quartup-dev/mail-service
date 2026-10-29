import {
  SendEmailCommand,
  type Destination,
  type MessageTag,
  type SESv2ClientConfig,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Clock } from '../../application/ports/clock';
import type { EmailApiProvider } from '../../application/ports/email-api-provider';
import type { SendResult } from '../../application/ports/send-result';
import type { Address, EmailMessage } from '../../domain/email';
import {
  PermanentProviderError,
  TransientProviderError,
  type ProviderError,
} from '../../domain/errors';
import { isNetworkError, isTransientHttpStatus } from './default-classification';
import { toMailOptions } from './mail-options';

// Lo que usamos de SESv2Client: el test lo sustituye en la frontera
export interface SesClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

export interface SesApiProviderDeps {
  client: SesClient;
  configurationSet?: string;
  clock: Clock;
}

// Credenciales por la cadena estándar del SDK. Sin reintentos propios (los gestiona solo la
// cola) y con timeouts: por defecto el SDK no corta una petición colgada
export function sesClientConfig(config: { region: string }): SESv2ClientConfig {
  return {
    region: config.region,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000 },
  };
}

export class SesApiProvider implements EmailApiProvider {
  readonly name = 'ses' as const;

  constructor(private readonly deps: SesApiProviderDeps) {}

  // Siempre Content.Raw: el MIME sale del mismo mapeo que el envío SMTP
  async send(message: EmailMessage): Promise<SendResult> {
    const mime = await new MailComposer(toMailOptions(message)).compile().build();
    const output = await this.deps.client
      .send(
        new SendEmailCommand({
          FromEmailAddress: message.from.email,
          Destination: destinationOf(message),
          Content: { Raw: { Data: mime } },
          EmailTags: tagsOf(message),
          // Los eventos de entrega llegan por SNS a través del configuration set
          ...(this.deps.configurationSet && { ConfigurationSetName: this.deps.configurationSet }),
        }),
      )
      .catch((error: unknown) => {
        throw classifySesError(error);
      });
    return {
      provider: this.name,
      providerMessageId: output.MessageId ?? '',
      acceptedAt: this.deps.clock.now(),
    };
  }
}

// Bcc no va en las cabeceras del MIME: los destinatarios se pasan siempre explícitos, y solo
// las listas con direcciones (la supresión puede dejar vacío el to)
function destinationOf(message: EmailMessage): Destination {
  const list = (field: keyof Destination, addresses: Address[] = []) =>
    addresses.length > 0 ? { [field]: addresses.map((address) => address.email) } : {};
  return {
    ...list('ToAddresses', message.to),
    ...list('CcAddresses', message.cc),
    ...list('BccAddresses', message.bcc),
  };
}

// El tag messageId vuelve en los eventos de SES para correlacionarlos. Los tags del mensaje van
// como nombre con valor "true", con los caracteres no admitidos sustituidos por "_"
function tagsOf(message: EmailMessage): MessageTag[] {
  const names = new Set((message.tags ?? []).map((tag) => tag.replace(/[^A-Za-z0-9_-]/g, '_')));
  return [
    { Name: 'messageId', Value: message.id },
    ...[...names].map((name) => ({ Name: name, Value: 'true' })),
  ];
}

const TRANSIENT_ERRORS = new Set([
  'TooManyRequestsException',
  'ThrottlingException',
  'LimitExceededException',
]);

const PERMANENT_ERRORS = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'SendingPausedException',
  'BadRequestException',
  'NotFoundException',
]);

// Campos de los errores del SDK de AWS. Un error de red no trae httpStatusCode
interface AwsErrorFields {
  $retryable?: object;
  $metadata?: { httpStatusCode?: number };
}

function classifySesError(error: unknown): ProviderError {
  const { transient, code } = classify(error);
  const ErrorClass = transient ? TransientProviderError : PermanentProviderError;
  const message = error instanceof Error ? error.message : String(error);
  return new ErrorClass(message, 'ses', code, { cause: error });
}

// Primero los casos explícitos de SES; después, la regla por defecto
function classify(error: unknown): { transient: boolean; code: string } {
  const name = error instanceof Error ? error.name : '';
  const { $retryable, $metadata } = fieldsOf(error);
  const status = $metadata?.httpStatusCode;
  if (TRANSIENT_ERRORS.has(name)) return { transient: true, code: `SES_${name}` };
  if (PERMANENT_ERRORS.has(name)) return { transient: false, code: `SES_${name}` };
  if ($retryable) return { transient: true, code: `SES_${name}` };
  if (status !== undefined) {
    return { transient: isTransientHttpStatus(status), code: `SES_HTTP_${status}` };
  }
  if (isNetworkError(error) || name === 'TimeoutError') {
    return { transient: true, code: 'SES_NETWORK_ERROR' };
  }
  return { transient: false, code: 'SES_ERROR' };
}

function fieldsOf(error: unknown): AwsErrorFields {
  return typeof error === 'object' && error !== null ? error : {};
}
