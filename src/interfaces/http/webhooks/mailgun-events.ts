import type { ProviderEvent, ProviderEventType } from '../../../domain/events';
import { withoutAngleBrackets } from '../../../infrastructure/providers/mailgun-api-provider';
import type { MailgunEventData } from '../schemas/webhooks';

// Traduce un evento de Mailgun; null si es un tipo que el servicio no sigue (opened, clicked...)
export function toProviderEvent(data: MailgunEventData): ProviderEvent | null {
  const type = eventTypeOf(data);
  if (!type) return null;
  const providerMessageId = data.message?.headers['message-id'];
  return {
    provider: 'mailgun',
    type,
    recipient: data.recipient,
    occurredAt: new Date(data.timestamp * 1_000),
    messageId: data['user-variables']?.messageId,
    providerMessageId: providerMessageId && withoutAngleBrackets(providerMessageId),
    raw: data,
  };
}

function eventTypeOf({ event, severity }: MailgunEventData): ProviderEventType | null {
  switch (event) {
    case 'delivered':
      return 'delivered';
    case 'failed':
      return severity === 'permanent' ? 'bounced' : 'temporary_failure';
    case 'complained':
      return 'complained';
    case 'unsubscribed':
      return 'unsubscribed';
    default:
      return null;
  }
}
