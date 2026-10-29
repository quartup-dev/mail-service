import type { CustomFile, MailgunMessageData, MessagesSendResult } from 'mailgun.js/definitions';
import type { Clock } from '../../application/ports/clock';
import type { EmailApiProvider } from '../../application/ports/email-api-provider';
import type { SendResult } from '../../application/ports/send-result';
import type { Address, Attachment, EmailMessage } from '../../domain/email';
import { PermanentProviderError } from '../../domain/errors';
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
    const result = await this.deps.messages.create(this.deps.domain, toMailgunData(message));
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
    ...(inline.length > 0 && { inline: inline.map((a) => toFile(a, a.contentId!)) }),
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
