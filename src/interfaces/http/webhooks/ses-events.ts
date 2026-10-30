import { z } from 'zod';
import type { ProviderEvent, ProviderEventType } from '../../../domain/events';

const recipientsOf = z.array(z.looseObject({ emailAddress: z.string() }));

// Evento de publicación de un configuration set de SES (campo Message del mensaje de SNS).
// Solo se validan los campos que usa el servicio; el resto se conserva para auditoría
export const SesEventSchema = z.looseObject({
  eventType: z.string(),
  mail: z.looseObject({
    messageId: z.string(),
    tags: z.record(z.string(), z.array(z.string())).optional(),
  }),
  delivery: z
    .looseObject({ timestamp: z.iso.datetime(), recipients: z.array(z.string()) })
    .optional(),
  bounce: z
    .looseObject({
      bounceType: z.string(),
      timestamp: z.iso.datetime(),
      bouncedRecipients: recipientsOf,
    })
    .optional(),
  complaint: z
    .looseObject({ timestamp: z.iso.datetime(), complainedRecipients: recipientsOf })
    .optional(),
});

export type SesEvent = z.output<typeof SesEventSchema>;

interface Occurrence {
  type: ProviderEventType;
  recipients: string[];
  timestamp: string;
}

// Un evento por destinatario afectado; [] si es un tipo que el servicio no sigue (Send, Open...)
export function toProviderEvents(event: SesEvent): ProviderEvent[] {
  const occurrence = occurrenceOf(event);
  if (!occurrence) return [];
  return occurrence.recipients.map((recipient) => ({
    provider: 'ses',
    type: occurrence.type,
    recipient,
    occurredAt: new Date(occurrence.timestamp),
    messageId: event.mail.tags?.messageId?.[0],
    providerMessageId: event.mail.messageId,
    raw: event,
  }));
}

function occurrenceOf({ eventType, delivery, bounce, complaint }: SesEvent): Occurrence | null {
  if (eventType === 'Delivery' && delivery) {
    return { type: 'delivered', recipients: delivery.recipients, timestamp: delivery.timestamp };
  }
  if (eventType === 'Bounce' && bounce) {
    return {
      // Solo el rebote permanente es un rebote; Transient y Undetermined solo se registran
      type: bounce.bounceType === 'Permanent' ? 'bounced' : 'temporary_failure',
      recipients: bounce.bouncedRecipients.map((recipient) => recipient.emailAddress),
      timestamp: bounce.timestamp,
    };
  }
  if (eventType === 'Complaint' && complaint) {
    return {
      type: 'complained',
      recipients: complaint.complainedRecipients.map((recipient) => recipient.emailAddress),
      timestamp: complaint.timestamp,
    };
  }
  return null;
}
