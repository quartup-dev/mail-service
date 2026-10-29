import type {
  Attachment as MailAttachment,
  Address as MailAddress,
  MailComposerOptions,
} from 'nodemailer';
import type { Address, Attachment, EmailMessage } from '../../domain/email';

// Correlaciona el correo con el mensaje interno en cualquier transporte
export const MAIL_SERVICE_ID_HEADER = 'X-Mail-Service-Id';

// Opciones de Nodemailer comunes al envío SMTP y al MIME de SES
export function toMailOptions(message: EmailMessage): MailComposerOptions {
  return {
    from: toMailAddress(message.from),
    to: message.to.map(toMailAddress),
    cc: (message.cc ?? []).map(toMailAddress),
    bcc: (message.bcc ?? []).map(toMailAddress),
    ...(message.replyTo && { replyTo: toMailAddress(message.replyTo) }),
    subject: message.subject,
    ...(message.text !== undefined && { text: message.text }),
    ...(message.html !== undefined && { html: message.html }),
    attachments: (message.attachments ?? []).map(toMailAttachment),
    headers: { ...message.headers, [MAIL_SERVICE_ID_HEADER]: message.id },
    // El contenido de los adjuntos siempre llega en base64: nunca se lee de rutas ni de URLs
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function toMailAttachment(attachment: Attachment): MailAttachment {
  return {
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: attachment.contentBase64,
    encoding: 'base64',
    ...(attachment.contentId && { cid: attachment.contentId }),
  };
}

function toMailAddress(address: Address): MailAddress {
  return { name: address.name ?? '', address: address.email };
}
