export interface Address {
  email: string;
  name?: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  contentBase64: string; // por ahora en línea; en el futuro, referencia a S3
  contentId?: string; // para imágenes inline (cid:)
}

export interface EmailMessage {
  id: string; // UUID v7 generado por el servicio
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string; // al menos uno de text/html es obligatorio
  attachments?: Attachment[];
  headers?: Record<string, string>;
  tags?: string[];
  metadata?: Record<string, string>;
  transport: TransportSpec;
}

// Petición de envío tal como llega del cliente: el id lo genera el servicio
export type EmailRequest = Omit<EmailMessage, 'id'>;

export type TransportType = 'smtp' | 'api';

export type TransportSpec = { type: 'smtp'; smtp: SmtpServerConfig } | { type: 'api' }; // el proveedor lo decide MAIL_API_PROVIDER

export interface SmtpServerConfig {
  host: string;
  // El 25 no se admite. El modo TLS se deduce del puerto:
  // 465 → TLS implícito; 587 → STARTTLS obligatorio
  port: 465 | 587;
  auth?: { user: string; pass: string };
  dkim?: { domainName: string; keySelector: string; privateKey: string };
}

export type ApiProviderName = 'mailgun' | 'ses';
export type ProviderName = 'smtp' | ApiProviderName;

// Ciclo de envío del mensaje completo
export type EmailStatus =
  | 'queued' // pendiente de envío (también entre reintentos)
  | 'sending' // un worker lo está procesando
  | 'sent' // aceptado por el servidor SMTP o el proveedor API
  | 'failed' // error permanente, reintentos agotados o caducado
  | 'suppressed'; // todos los destinatarios estaban suprimidos

export const FINAL_EMAIL_STATUSES: readonly EmailStatus[] = ['sent', 'failed', 'suppressed'];

export function isFinalEmailStatus(status: EmailStatus): boolean {
  return FINAL_EMAIL_STATUSES.includes(status);
}

export type RecipientKind = 'to' | 'cc' | 'bcc';

export type RecipientStatus =
  | 'pending' // aún no enviado
  | 'suppressed' // omitido por la lista de supresión
  | 'rejected' // rechazado por el servidor SMTP en el RCPT TO
  | 'accepted' // aceptado por el servidor o proveedor
  | 'delivered' // confirmado por evento del proveedor
  | 'bounced' // rebote permanente
  | 'complained' // marcado como spam
  | 'unsubscribed'; // baja solicitada por el destinatario

export interface EmailRecipient {
  email: string; // en minúsculas
  kind: RecipientKind;
  status: RecipientStatus;
  updatedAt: Date;
}

// El estado solo avanza. Los eventos con rango menor o igual no lo cambian
const RECIPIENT_STATUS_RANK: Record<RecipientStatus, number> = {
  pending: 0,
  accepted: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  unsubscribed: 3,
  suppressed: 9,
  rejected: 9,
};

export function recipientStatusRank(status: RecipientStatus): number {
  return RECIPIENT_STATUS_RANK[status];
}

export function canAdvanceRecipientStatus(
  current: RecipientStatus,
  next: RecipientStatus,
): boolean {
  return recipientStatusRank(next) > recipientStatusRank(current);
}

// Destinatarios de to, cc y bcc, con la dirección en minúsculas
export function recipientsOf(
  message: Pick<EmailMessage, 'to' | 'cc' | 'bcc'>,
): Array<{ email: string; kind: RecipientKind }> {
  const withKind = (kind: RecipientKind) => (address: Address) => ({
    email: address.email.toLowerCase(),
    kind,
  });
  return [
    ...message.to.map(withKind('to')),
    ...(message.cc ?? []).map(withKind('cc')),
    ...(message.bcc ?? []).map(withKind('bcc')),
  ];
}
