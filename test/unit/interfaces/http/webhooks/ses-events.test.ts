import { describe, expect, it } from 'vitest';
import {
  toProviderEvents,
  type SesEvent,
} from '../../../../../src/interfaces/http/webhooks/ses-events';

const MESSAGE_ID = '0192f0c4-0000-7000-8000-000000000001';
const SES_MESSAGE_ID = '010201923a5b6c7d-abcdef-000000';

const mail = { messageId: SES_MESSAGE_ID, tags: { messageId: [MESSAGE_ID] } };

describe('toProviderEvents (SES)', () => {
  it('maps a Delivery to one delivered event per recipient', () => {
    const event: SesEvent = {
      eventType: 'Delivery',
      mail,
      delivery: {
        timestamp: '2026-10-30T10:00:01.000Z',
        recipients: ['a@dominio.com', 'b@dominio.com'],
      },
    };

    expect(toProviderEvents(event)).toEqual(
      ['a@dominio.com', 'b@dominio.com'].map((recipient) => ({
        provider: 'ses',
        type: 'delivered',
        recipient,
        occurredAt: new Date('2026-10-30T10:00:01.000Z'),
        messageId: MESSAGE_ID,
        providerMessageId: SES_MESSAGE_ID,
        raw: event,
      })),
    );
  });

  const bounce = (bounceType: string): SesEvent => ({
    eventType: 'Bounce',
    mail,
    bounce: {
      bounceType,
      timestamp: '2026-10-30T10:00:02.000Z',
      bouncedRecipients: [{ emailAddress: 'a@dominio.com' }, { emailAddress: 'b@dominio.com' }],
    },
  });

  it('maps a Permanent Bounce to one bounced event per bounced recipient', () => {
    const events = toProviderEvents(bounce('Permanent'));

    expect(
      events.map(({ type, recipient, occurredAt }) => ({ type, recipient, occurredAt })),
    ).toEqual(
      ['a@dominio.com', 'b@dominio.com'].map((recipient) => ({
        type: 'bounced',
        recipient,
        occurredAt: new Date('2026-10-30T10:00:02.000Z'),
      })),
    );
  });

  it.each(['Transient', 'Undetermined'])('maps a %s Bounce to temporary failures', (bounceType) => {
    expect(toProviderEvents(bounce(bounceType)).map((event) => event.type)).toEqual([
      'temporary_failure',
      'temporary_failure',
    ]);
  });

  it('maps a Complaint to one complained event per complained recipient', () => {
    const events = toProviderEvents({
      eventType: 'Complaint',
      mail,
      complaint: {
        timestamp: '2026-10-30T10:05:00.000Z',
        complainedRecipients: [{ emailAddress: 'a@dominio.com' }],
      },
    });

    expect(events).toMatchObject([
      {
        type: 'complained',
        recipient: 'a@dominio.com',
        occurredAt: new Date('2026-10-30T10:05:00.000Z'),
        messageId: MESSAGE_ID,
      },
    ]);
  });

  it('keeps only the provider message id when the messageId tag is missing', () => {
    const [event] = toProviderEvents({
      ...bounce('Permanent'),
      mail: { messageId: SES_MESSAGE_ID },
    });

    expect(event?.messageId).toBeUndefined();
    expect(event?.providerMessageId).toBe(SES_MESSAGE_ID);
  });

  it.each(['Send', 'Reject', 'Open', 'Click', 'DeliveryDelay', 'Rendering Failure'])(
    'ignores a %s event',
    (eventType) => {
      expect(toProviderEvents({ eventType, mail })).toEqual([]);
    },
  );
});
