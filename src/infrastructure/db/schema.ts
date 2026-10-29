import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AttemptOutcome } from '../../application/ports/email-repository';
import type { SuppressionReason } from '../../application/ports/suppression-repository';
import type {
  EmailMessage,
  EmailStatus,
  ProviderName,
  RecipientKind,
  RecipientStatus,
  TransportType,
} from '../../domain/email';
import type { ProviderEventType } from '../../domain/events';

// Las fechas siempre las pone la aplicación con su Clock, con precisión de milisegundos
const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

export const apiClients = pgTable('api_clients', {
  id: text('id').primaryKey(), // [a-z0-9-]{3,32}
  name: text('name').notNull(),
  status: text('status').$type<'active' | 'disabled'>().notNull(),
  allowedTransports: text('allowed_transports').array().$type<TransportType[]>().notNull(),
  allowedFromDomains: text('allowed_from_domains').array(),
  rateLimitPerMinute: integer('rate_limit_per_minute'),
  createdAt: timestampColumn('created_at').notNull(),
  updatedAt: timestampColumn('updated_at').notNull(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    clientId: text('client_id')
      .notNull()
      .references(() => apiClients.id),
    keyId: text('key_id').notNull(),
    hash: text('hash').notNull(), // hmac-sha256:<base64>
    status: text('status').$type<'active' | 'revoked'>().notNull(),
    createdAt: timestampColumn('created_at').notNull(),
    expiresAt: timestampColumn('expires_at'),
    revokedAt: timestampColumn('revoked_at'),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.keyId] })],
);

export const emails = pgTable(
  'emails',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => apiClients.id),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash').notNull(),
    requestId: text('request_id').notNull(),
    payload: jsonb('payload').$type<EmailMessage>(), // sin credenciales SMTP; null tras la retención
    transport: text('transport').$type<TransportType>().notNull(),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpConfigEncrypted: text('smtp_config_encrypted'),
    status: text('status').$type<EmailStatus>().notNull(),
    provider: text('provider').$type<ProviderName>(),
    providerMessageId: text('provider_message_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestampColumn('created_at').notNull(),
    updatedAt: timestampColumn('updated_at').notNull(),
    sentAt: timestampColumn('sent_at'),
  },
  (t) => [
    uniqueIndex('emails_client_idempotency_key_uq').on(t.clientId, t.idempotencyKey),
    uniqueIndex('emails_provider_message_id_uq').on(t.provider, t.providerMessageId),
    index('emails_status_updated_at_idx').on(t.status, t.updatedAt),
    index('emails_status_created_at_idx').on(t.status, t.createdAt),
  ],
);

export const emailRecipients = pgTable(
  'email_recipients',
  {
    emailId: uuid('email_id')
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    email: text('email').notNull(), // en minúsculas
    kind: text('kind').$type<RecipientKind>().notNull(),
    position: smallint('position').notNull(), // orden de to, cc y bcc en la petición
    status: text('status').$type<RecipientStatus>().notNull(),
    statusRank: smallint('status_rank').notNull(), // permite transiciones atómicas y monótonas
    updatedAt: timestampColumn('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.emailId, t.email] })],
);

export const emailAttempts = pgTable(
  'email_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    emailId: uuid('email_id')
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    transport: text('transport').$type<TransportType>().notNull(),
    provider: text('provider').$type<ProviderName>(),
    outcome: text('outcome').$type<AttemptOutcome>().notNull(),
    code: text('code'),
    message: text('message'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: timestampColumn('created_at').notNull(),
  },
  // Para cargar los intentos de un mensaje y para el borrado en cascada
  (t) => [index('email_attempts_email_id_idx').on(t.emailId)],
);

export const emailEvents = pgTable(
  'email_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    emailId: uuid('email_id').references(() => emails.id, { onDelete: 'cascade' }),
    recipient: text('recipient'),
    provider: text('provider').$type<ProviderName>().notNull(),
    type: text('type').$type<ProviderEventType>().notNull(),
    raw: jsonb('raw').$type<unknown>().notNull(),
    occurredAt: timestampColumn('occurred_at').notNull(),
    receivedAt: timestampColumn('received_at').notNull(),
  },
  (t) => [
    index('email_events_received_at_idx').on(t.receivedAt),
    index('email_events_email_id_idx').on(t.emailId),
  ],
);

export const suppressions = pgTable('suppressions', {
  email: text('email').primaryKey(), // en minúsculas
  reason: text('reason').$type<SuppressionReason>().notNull(),
  source: text('source').$type<ProviderName | 'cli'>().notNull(),
  createdAt: timestampColumn('created_at').notNull(),
});
