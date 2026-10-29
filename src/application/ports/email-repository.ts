import type {
  EmailMessage,
  EmailRecipient,
  EmailStatus,
  ProviderName,
  RecipientStatus,
  TransportType,
} from '../../domain/email';
import type { ProviderEventType } from '../../domain/events';

export type AttemptOutcome = 'success' | 'transient_error' | 'permanent_error';

export interface AttemptRecord {
  attempt: number;
  transport: TransportType;
  provider: ProviderName | null; // null si el envío falló antes de elegir proveedor
  outcome: AttemptOutcome;
  code: string | null;
  message: string | null;
  durationMs: number;
  createdAt: Date;
}

export interface StoredEvent {
  emailId: string | null; // null si no se correlacionó con ningún mensaje
  recipient: string | null;
  provider: ProviderName;
  type: ProviderEventType;
  raw: unknown;
  occurredAt: Date;
  receivedAt: Date;
}

export interface StoredEmail {
  id: string;
  clientId: string;
  idempotencyKey: string | null;
  requestHash: string;
  requestId: string;
  payload: EmailMessage | null; // sin credenciales SMTP; null tras la retención
  transport: TransportType;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpConfigEncrypted: string | null;
  status: EmailStatus;
  provider: ProviderName | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  recipients: EmailRecipient[];
  attempts: AttemptRecord[];
}

export type EmailStatusPatch = Partial<
  Pick<
    StoredEmail,
    | 'provider'
    | 'providerMessageId'
    | 'errorCode'
    | 'errorMessage'
    | 'sentAt'
    | 'smtpConfigEncrypted'
  >
>;

export interface CreateEmailInput {
  message: EmailMessage; // sin credenciales SMTP en claro
  clientId: string;
  requestId: string;
  requestHash: string; // hash del cuerpo para la comparación de idempotencia
  idempotencyKey?: string;
  smtpConfigEncrypted?: string; // salida de SecretBox.encrypt, solo con transport smtp
}

export interface EmailRepository {
  // Inserta mensaje y destinatarios en una transacción. Si ya existe (client_id, idempotency_key),
  // no inserta y devuelve el existente con created = false (también ante peticiones simultáneas)
  create(input: CreateEmailInput): Promise<{ email: StoredEmail; created: boolean }>;
  findById(id: string): Promise<StoredEmail | null>;
  findByProviderMessageId(
    provider: ProviderName,
    providerMessageId: string,
  ): Promise<StoredEmail | null>;
  updateStatus(id: string, status: EmailStatus, patch?: EmailStatusPatch): Promise<void>;
  recordAttempt(id: string, attempt: AttemptRecord): Promise<void>;
  // Actualización en lote desde el worker; respeta el rango igual que advanceRecipientStatus
  setRecipientStatuses(
    id: string,
    updates: Array<{ email: string; status: RecipientStatus }>,
  ): Promise<void>;
  // Aplica la transición solo si el rango nuevo es mayor; devuelve si se aplicó
  advanceRecipientStatus(
    id: string,
    email: string,
    status: RecipientStatus,
    occurredAt: Date,
  ): Promise<boolean>;
  // Mensajes en queued o sending filtrados por created_at y/o updated_at (para el barrido)
  findPending(
    filter: { createdBefore?: Date; updatedBefore?: Date },
    limit: number,
  ): Promise<StoredEmail[]>;
  // Guarda un evento de proveedor (emailId nulo si no se correlacionó)
  recordEvent(event: StoredEvent): Promise<void>;
  // Retención: cada método procesa como máximo `limit` filas y devuelve cuántas afectó
  clearPayloads(finalBefore: Date, limit: number): Promise<number>;
  deleteEvents(receivedBefore: Date, limit: number): Promise<number>;
  deleteFinalEmails(createdBefore: Date, limit: number): Promise<number>;
}
