import { describe, expect, it } from 'vitest';
import type { MailgunEventData } from '../../../../../src/interfaces/http/schemas/webhooks';
import { toProviderEvent } from '../../../../../src/interfaces/http/webhooks/mailgun-events';

const MESSAGE_ID = '0192f0c4-0000-7000-8000-000000000001';

const eventData = (overrides: Partial<MailgunEventData> = {}): MailgunEventData => ({
  event: 'delivered',
  timestamp: 1_792_000_000.329,
  recipient: 'a@dominio.com',
  message: { headers: { 'message-id': '20261029.abc@mg.example.com' } },
  'user-variables': { messageId: MESSAGE_ID },
  ...overrides,
});

describe('toProviderEvent (Mailgun)', () => {
  it('maps a delivered event with recipient, time and both message ids', () => {
    const data = eventData();

    expect(toProviderEvent(data)).toEqual({
      provider: 'mailgun',
      type: 'delivered',
      recipient: 'a@dominio.com',
      occurredAt: new Date(1_792_000_000_329),
      messageId: MESSAGE_ID,
      providerMessageId: '20261029.abc@mg.example.com',
      raw: data,
    });
  });

  it.each([
    [{ event: 'failed', severity: 'permanent' }, 'bounced'],
    [{ event: 'failed', severity: 'temporary' }, 'temporary_failure'],
    [{ event: 'complained' }, 'complained'],
    [{ event: 'unsubscribed' }, 'unsubscribed'],
  ] as const)('maps %o to %s', (overrides, type) => {
    expect(toProviderEvent(eventData(overrides))).toMatchObject({ type });
  });

  it('keeps only the provider message id when there are no user variables', () => {
    const event = toProviderEvent(eventData({ 'user-variables': undefined }));

    expect(event?.messageId).toBeUndefined();
    expect(event?.providerMessageId).toBe('20261029.abc@mg.example.com');
  });

  it('removes the angle brackets of the provider message id', () => {
    const event = toProviderEvent(
      eventData({ message: { headers: { 'message-id': '<20261029.abc@mg.example.com>' } } }),
    );

    expect(event?.providerMessageId).toBe('20261029.abc@mg.example.com');
  });

  it.each(['accepted', 'opened', 'clicked', 'stored'])('ignores a %s event', (event) => {
    expect(toProviderEvent(eventData({ event }))).toBeNull();
  });
});
