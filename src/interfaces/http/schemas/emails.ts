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

export const ProviderNameSchema = z.enum(['smtp', 'mailgun', 'ses']).meta({
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
  .meta({
    id: 'EmailStatusResponse',
    description: 'Estado de envío y de entrega de un mensaje',
    examples: [
      {
        id: '0192f0c4-5b1e-7c3a-9d2e-4f6a8b0c1d2e',
        status: 'sent',
        transport: 'api',
        provider: 'mailgun',
        providerMessageId: '20261029.abc@mg.example.com',
        smtp: null,
        errorCode: null,
        errorMessage: null,
        recipients: [
          {
            email: 'a@dominio.com',
            kind: 'to',
            status: 'delivered',
            updatedAt: '2026-10-29T10:00:05.000Z',
          },
          {
            email: 'b@dominio.com',
            kind: 'cc',
            status: 'bounced',
            updatedAt: '2026-10-29T10:00:07.000Z',
          },
        ],
        deliverySummary: { delivered: 1, bounced: 1 },
        attempts: [
          {
            attempt: 1,
            transport: 'api',
            provider: 'mailgun',
            outcome: 'success',
            code: null,
            message: null,
            durationMs: 240,
            createdAt: '2026-10-29T10:00:01.000Z',
          },
        ],
        createdAt: '2026-10-29T10:00:00.000Z',
        updatedAt: '2026-10-29T10:00:01.000Z',
        sentAt: '2026-10-29T10:00:01.000Z',
      },
    ],
  });

export const EmailIdParamsSchema = z.object({ id: z.uuid().describe('Identificador del mensaje') });

// --- Petición de envío ---

const MAX_RECIPIENTS = 50;

// Cabeceras que construye el servicio o el transporte: el cliente no puede fijarlas
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'sender',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'return-path',
  'dkim-signature',
  'x-mail-service-id',
]);

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

// Un salto de línea permitiría inyectar cabeceras en el mensaje
const singleLine = (schema: z.ZodString) =>
  schema.refine((value) => !/[\r\n]/.test(value), 'must not contain line breaks');

export const AddressSchema = z
  .strictObject({
    email: z.email().max(254),
    name: singleLine(z.string().max(200)).optional(),
  })
  .meta({ id: 'Address', description: 'Dirección de correo con nombre opcional' });

export const AttachmentSchema = z
  .strictObject({
    filename: singleLine(z.string().min(1).max(255)),
    contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, 'must be a MIME type like text/plain'),
    contentBase64: z.base64(),
    contentId: singleLine(z.string().min(1).max(255))
      .optional()
      .describe('Para imágenes en línea referenciadas con cid:'),
  })
  .meta({ id: 'Attachment', description: 'Adjunto codificado en base64' });

export const SmtpServerSchema = z
  .strictObject({
    host: z.string().min(1).max(253),
    port: z
      .union([z.literal(465), z.literal(587)])
      .describe('465: TLS implícito; 587: STARTTLS obligatorio. El 25 no se admite'),
    auth: z.strictObject({ user: z.string().min(1), pass: z.string().min(1) }).optional(),
    dkim: z
      .strictObject({
        domainName: z.string().min(1),
        keySelector: z.string().min(1),
        privateKey: z.string().min(1),
      })
      .optional(),
  })
  .meta({
    id: 'SmtpServer',
    description: 'Servidor SMTP del cliente; las credenciales se guardan cifradas',
  });

export const SmtpTransportSchema = z
  .strictObject({ type: z.literal('smtp'), smtp: SmtpServerSchema })
  .meta({ id: 'SmtpTransport', description: 'Envío por el servidor SMTP indicado' });

export const ApiTransportSchema = z.strictObject({ type: z.literal('api') }).meta({
  id: 'ApiTransport',
  description: 'Envío por el proveedor de API configurado en el servicio',
});

const recipients = z.array(AddressSchema);

export const EmailRequestSchema = z
  .strictObject({
    transport: z.discriminatedUnion('type', [SmtpTransportSchema, ApiTransportSchema]),
    from: AddressSchema,
    to: recipients.min(1),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    replyTo: AddressSchema.optional(),
    subject: singleLine(z.string().min(1)),
    text: z.string().optional(),
    html: z.string().optional(),
    attachments: z.array(AttachmentSchema).optional(),
    headers: z
      .record(
        z.string().regex(HEADER_NAME, 'must be a valid header name'),
        singleLine(z.string().max(998)),
      )
      .optional()
      .describe('Cabeceras adicionales; no se admiten las que construye el servicio'),
    tags: z.array(singleLine(z.string().min(1).max(128))).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((request, ctx) => {
    const all = [
      ...request.to.map((address, index) => ({ address, path: ['to', index, 'email'] })),
      ...(request.cc ?? []).map((address, index) => ({ address, path: ['cc', index, 'email'] })),
      ...(request.bcc ?? []).map((address, index) => ({ address, path: ['bcc', index, 'email'] })),
    ];
    if (all.length > MAX_RECIPIENTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `at most ${MAX_RECIPIENTS} recipients in to, cc and bcc together`,
      });
    }
    const seen = new Set<string>();
    for (const { address, path } of all) {
      const email = address.email.toLowerCase();
      if (seen.has(email)) {
        ctx.addIssue({ code: 'custom', path, message: 'duplicated recipient in to, cc or bcc' });
      }
      seen.add(email);
    }
    if (request.text === undefined && request.html === undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'text or html is required' });
    }
    for (const name of Object.keys(request.headers ?? {})) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        ctx.addIssue({ code: 'custom', path: ['headers', name], message: 'reserved header' });
      }
    }
  })
  .meta({
    id: 'EmailRequest',
    description: 'Petición de envío de un correo',
    examples: [
      {
        transport: {
          type: 'smtp',
          smtp: {
            host: 'smtp.example.com',
            port: 587,
            auth: { user: 'notificaciones@example.com', pass: '••••••' },
          },
        },
        from: { email: 'notificaciones@example.com', name: 'Example' },
        to: [{ email: 'cliente@dominio.com' }],
        subject: 'Bienvenido',
        html: '<p>Hola</p>',
        text: 'Hola',
      },
      {
        transport: { type: 'api' },
        from: { email: 'notificaciones@example.com' },
        to: [{ email: 'cliente@dominio.com' }],
        subject: 'Bienvenido',
        text: 'Hola',
      },
    ],
  });

export const EmailRequestHeadersSchema = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Repetir la petición con la misma clave no crea otro mensaje'),
});
