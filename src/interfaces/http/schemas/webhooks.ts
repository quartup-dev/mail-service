import { z } from 'zod';

// Solo se validan los campos que usa el servicio; el resto del evento se conserva para auditoría
export const MailgunEventDataSchema = z
  .looseObject({
    event: z.string().describe('delivered, failed, complained, unsubscribed... El resto se ignora'),
    timestamp: z.number().describe('Hora del evento, en segundos desde epoch'),
    recipient: z.string().describe('Destinatario afectado'),
    severity: z
      .enum(['permanent', 'temporary'])
      .optional()
      .describe('Solo en failed: permanent es un rebote'),
    message: z
      .looseObject({
        headers: z.looseObject({
          'message-id': z.string().optional().describe('Id del mensaje en Mailgun, sin <>'),
        }),
      })
      .optional(),
    'user-variables': z
      .looseObject({
        messageId: z.string().optional().describe('Id interno del mensaje (v:messageId)'),
      })
      .optional(),
  })
  .meta({ id: 'MailgunEventData', description: 'Evento de Mailgun' });

export const MailgunSignatureSchema = z
  .object({
    timestamp: z.string().describe('Segundos desde epoch'),
    token: z.string().describe('Cadena aleatoria de un solo uso'),
    signature: z.string().describe('HMAC-SHA256 en hex de timestamp + token'),
  })
  .meta({ id: 'MailgunSignature', description: 'Firma del webhook de Mailgun' });

export const MailgunWebhookRequestSchema = z
  .object({
    signature: MailgunSignatureSchema,
    'event-data': MailgunEventDataSchema,
  })
  .meta({ id: 'MailgunWebhookRequest', description: 'Webhook de eventos de Mailgun' });

export type MailgunEventData = z.output<typeof MailgunEventDataSchema>;
