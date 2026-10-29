import type {
  CustomFile,
  MailgunClientOptions,
  MailgunMessageData,
  MessagesSendResult,
} from 'mailgun.js/definitions';
import type { Clock } from '../../application/ports/clock';
import type { EmailApiProvider } from '../../application/ports/email-api-provider';
import type { SendResult } from '../../application/ports/send-result';
import type { Address, Attachment, EmailMessage } from '../../domain/email';
import {
  PermanentProviderError,
  TransientProviderError,
  type ProviderError,
} from '../../domain/errors';
import { isNetworkError, isTransientHttpStatus } from './default-classification';
import { MAIL_SERVICE_ID_HEADER } from './mail-options';

// Lo que usamos del cliente de mailgun.js: el test lo sustituye en la frontera
export interface MailgunMessages {
  create(domain: string, data: MailgunMessageData): Promise<MessagesSendResult>;
}

export interface MailgunApiProviderDeps {
  messages: MailgunMessages;
  domain: string;
  clock: Clock;
}

const MAILGUN_URLS = { eu: 'https://api.eu.mailgun.net', us: 'https://api.mailgun.net' };

// mailgun.js no pone timeout por defecto: sin él, una petición colgada bloquearía el job
const MAILGUN_TIMEOUT_MS = 30_000;

export function mailgunClientOptions(config: {
  apiKey: string;
  region: 'eu' | 'us';
}): MailgunClientOptions {
  return {
    username: 'api',
    key: config.apiKey,
    url: MAILGUN_URLS[config.region],
    timeout: MAILGUN_TIMEOUT_MS,
  };
}

export class MailgunApiProvider implements EmailApiProvider {
  readonly name = 'mailgun' as const;

  constructor(private readonly deps: MailgunApiProviderDeps) {}

  async send(message: EmailMessage): Promise<SendResult> {
    if (message.to.length === 0) {
      throw new PermanentProviderError(
        'Mailgun requires at least one to recipient',
        this.name,
        'MAILGUN_TO_REQUIRED',
      );
    }
    const result = await this.deps.messages
      .create(this.deps.domain, toMailgunData(message))
      .catch((error: unknown) => {
        throw classifyMailgunError(error);
      });
    return {
      provider: this.name,
      providerMessageId: (result.id ?? '').replace(/^<|>$/g, ''),
      acceptedAt: this.deps.clock.now(),
    };
  }
}

function toMailgunData(message: EmailMessage): MailgunMessageData {
  return {
    from: formatAddress(message.from),
    to: message.to.map(formatAddress),
    cc: (message.cc ?? []).map(formatAddress),
    bcc: (message.bcc ?? []).map(formatAddress),
    subject: message.subject,
    ...(message.text !== undefined && { text: message.text }),
    ...(message.html !== undefined && { html: message.html }),
    ...(message.replyTo && { 'h:Reply-To': formatAddress(message.replyTo) }),
    ...prefixKeys('h:', { ...message.headers, [MAIL_SERVICE_ID_HEADER]: message.id }),
    // Vuelve en los webhooks como user-variables.messageId para correlacionar eventos
    'v:messageId': message.id,
    ...(message.tags?.length && { 'o:tag': message.tags }),
    ...attachmentsOf(message.attachments ?? []),
    // El tipo de mailgun.js exige saber en compilación que hay text o html; lo garantiza la API
  } as MailgunMessageData;
}

// Las imágenes inline se nombran con su contentId: Mailgun usa el nombre de fichero como cid
function attachmentsOf(attachments: Attachment[]): {
  attachment?: CustomFile[];
  inline?: CustomFile[];
} {
  const toFile = (attachment: Attachment, filename: string): CustomFile => ({
    filename,
    contentType: attachment.contentType,
    data: Buffer.from(attachment.contentBase64, 'base64'),
  });
  const regular = attachments.filter((attachment) => !attachment.contentId);
  const inline = attachments.filter((attachment) => attachment.contentId);
  return {
    ...(regular.length > 0 && { attachment: regular.map((a) => toFile(a, a.filename)) }),
    ...(inline.length > 0 && { inline: inline.map((a) => toFile(a, a.contentId ?? a.filename)) }),
  };
}

function prefixKeys(prefix: string, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [prefix + key, value]));
}

// Formato "Nombre" <dirección>, con el nombre entre comillas para admitir comas y comillas
function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  const quoted = address.name.replace(/[\\"]/g, (char) => `\\${char}`);
  return `"${quoted}" <${address.email}>`;
}

// Campos del error HTTP de mailgun.js (su clase no se exporta: se reconoce por type)
interface MailgunApiErrorFields {
  type?: string;
  status?: number;
  details?: string;
}

// Sin respuesta, mailgun.js pone estado 400 y el código de error de Node o axios como mensaje
const NETWORK_ERROR_MESSAGE = /^E[A-Z_]+$/;

function classifyMailgunError(error: unknown): ProviderError {
  const { transient, code } = classify(error);
  const ErrorClass = transient ? TransientProviderError : PermanentProviderError;
  const { details } = fieldsOf(error);
  const message = error instanceof Error ? error.message : String(error);
  return new ErrorClass(details ? `${message}: ${details}` : message, 'mailgun', code, {
    cause: error,
  });
}

function classify(error: unknown): { transient: boolean; code: string } {
  const { type, status = 0 } = fieldsOf(error);
  const message = error instanceof Error ? error.message : '';
  if (type !== 'MailgunAPIError') {
    return isNetworkError(error)
      ? { transient: true, code: 'MAILGUN_NETWORK_ERROR' }
      : { transient: false, code: 'MAILGUN_ERROR' };
  }
  if (status === 400 && NETWORK_ERROR_MESSAGE.test(message)) {
    return { transient: true, code: 'MAILGUN_NETWORK_ERROR' };
  }
  return { transient: isTransientHttpStatus(status), code: `MAILGUN_HTTP_${status}` };
}

function fieldsOf(error: unknown): MailgunApiErrorFields {
  return typeof error === 'object' && error !== null ? error : {};
}
