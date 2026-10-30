import { createHmac, randomBytes } from 'node:crypto';
import type { Clock } from '../../src/application/ports/clock';
import type { MailgunEventData } from '../../src/interfaces/http/schemas/webhooks';

export const MAILGUN_SIGNING_KEY = 'test-mailgun-signing-key';

// Cuerpo de un webhook de Mailgun firmado con la clave de los tests y la hora del reloj
export function signedMailgunWebhook(
  clock: Clock,
  eventData: Partial<MailgunEventData> & { recipient: string },
  signature: { timestamp?: string; token?: string } = {},
) {
  const timestamp = signature.timestamp ?? String(Math.floor(clock.now().getTime() / 1_000));
  const token = signature.token ?? randomBytes(25).toString('hex');
  return {
    signature: {
      timestamp,
      token,
      signature: createHmac('sha256', MAILGUN_SIGNING_KEY)
        .update(timestamp + token)
        .digest('hex'),
    },
    'event-data': {
      event: 'delivered',
      timestamp: clock.now().getTime() / 1_000,
      ...eventData,
    },
  };
}
