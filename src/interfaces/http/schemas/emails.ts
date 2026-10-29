import { z } from 'zod';

export const EmailStatusSchema = z
  .enum(['queued', 'sending', 'sent', 'failed', 'suppressed'])
  .meta({ id: 'EmailStatus', description: 'Estado del envío del mensaje' });

export const RecipientStatusSchema = z
  .enum([
    'pending',
    'suppressed',
    'rejected',
    'accepted',
    'delivered',
    'bounced',
    'complained',
    'unsubscribed',
  ])
  .meta({ id: 'RecipientStatus', description: 'Estado de entrega de un destinatario' });

export const RecipientKindSchema = z
  .enum(['to', 'cc', 'bcc'])
  .meta({ id: 'RecipientKind', description: 'Campo en el que va el destinatario' });

export const TransportTypeSchema = z
  .enum(['smtp', 'api'])
  .meta({ id: 'TransportType', description: 'Transporte de envío' });

export const ProviderNameSchema = z
  .enum(['smtp', 'mailgun', 'ses'])
  .meta({
    id: 'ProviderName',
    description: 'Servidor SMTP o proveedor de API que aceptó el envío',
  });

export const AttemptOutcomeSchema = z
  .enum(['success', 'transient_error', 'permanent_error'])
  .meta({ id: 'AttemptOutcome', description: 'Resultado de un intento de envío' });

const timestamp = z.iso.datetime();

export const EmailAcceptedSchema = z
  .object({
    id: z.uuid().describe('Identificador del mensaje (UUID v7)'),
    status: EmailStatusSchema,
    transport: TransportTypeSchema,
  })
  .meta({ id: 'EmailAccepted', description: 'Mensaje aceptado para su envío' });

export const EmailRecipientStatusSchema = z
  .object({
    email: z.email(),
    kind: RecipientKindSchema,
    status: RecipientStatusSchema,
    updatedAt: timestamp,
  })
  .meta({ id: 'EmailRecipientStatus', description: 'Estado de entrega de un destinatario' });

export const EmailAttemptSchema = z
  .object({
    attempt: z.int().positive().describe('Número de intento, desde 1'),
    transport: TransportTypeSchema,
    provider: ProviderNameSchema.nullable(),
    outcome: AttemptOutcomeSchema,
    code: z.string().nullable().describe('Código del error del proveedor'),
    message: z.string().nullable().describe('Mensaje del error del proveedor'),
    durationMs: z.int().nonnegative(),
    createdAt: timestamp,
  })
  .meta({ id: 'EmailAttempt', description: 'Intento de envío' });

const count = z.int().positive().optional();

export const DeliverySummarySchema = z
  .object({
    pending: count,
    suppressed: count,
    rejected: count,
    accepted: count,
    delivered: count,
    bounced: count,
    complained: count,
    unsubscribed: count,
  })
  .meta({
    id: 'DeliverySummary',
    description: 'Número de destinatarios por estado; solo aparecen los estados presentes',
  });

export const EmailStatusResponseSchema = z
  .object({
    id: z.uuid(),
    status: EmailStatusSchema,
    transport: TransportTypeSchema,
    provider: ProviderNameSchema.nullable(),
    providerMessageId: z.string().nullable(),
    smtp: z
      .object({ host: z.string(), port: z.int() })
      .nullable()
      .describe('Servidor SMTP, sin credenciales; null con transport api'),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    recipients: z.array(EmailRecipientStatusSchema),
    deliverySummary: DeliverySummarySchema,
    attempts: z.array(EmailAttemptSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
    sentAt: timestamp.nullable(),
  })
  .meta({ id: 'EmailStatusResponse', description: 'Estado de envío y de entrega de un mensaje' });

export const EmailIdParamsSchema = z.object({ id: z.uuid().describe('Identificador del mensaje') });
