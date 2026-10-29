import { describe, expect, it } from 'vitest';
import { HandleProviderEvent } from '../../../src/application/handle-provider-event';
import type { ProviderEvent } from '../../../src/domain/events';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { InMemorySuppressionRepository } from '../../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { messageFrom } from '../../support/email-messages';
import { apiRequest } from '../../support/email-requests';
import { FakeClock } from '../../support/fake-clock';

const PROVIDER_MESSAGE_ID = '20261029.abc@mg.example.com';

async function setup() {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const suppressions = new InMemorySuppressionRepository(clock);
  const { email } = await emails.create({
    message: messageFrom(
      apiRequest({ to: [{ email: 'a@dominio.com' }, { email: 'b@dominio.com' }] }),
    ),
    clientId: 'billing',
    requestId: 'req-1',
    requestHash: 'hash-1',
  });
  await emails.updateStatus(email.id, 'sent', {
    provider: 'mailgun',
    providerMessageId: PROVIDER_MESSAGE_ID,
  });
  await emails.setRecipientStatuses(email.id, [
    { email: 'a@dominio.com', status: 'accepted' },
    { email: 'b@dominio.com', status: 'accepted' },
  ]);

  const useCase = new HandleProviderEvent({ emails, suppressions, clock });
  const event = (overrides: Partial<ProviderEvent> = {}): ProviderEvent => ({
    provider: 'mailgun',
    type: 'delivered',
    recipient: 'a@dominio.com',
    occurredAt: clock.now(),
    messageId: email.id,
    raw: { event: 'delivered' },
    ...overrides,
  });
  const statusesOf = async () =>
    Object.fromEntries(
      ((await emails.findById(email.id))?.recipients ?? []).map((r) => [r.email, r.status]),
    );

  return { clock, emails, suppressions, useCase, event, emailId: email.id, statusesOf };
}

describe('HandleProviderEvent', () => {
  it('correlates by internal id, records the event and advances only the affected recipient', async () => {
    const { useCase, event, emails, emailId, statusesOf, clock } = await setup();
    const occurredAt = new Date('2026-10-29T09:59:00.000Z');

    await useCase.execute(event({ recipient: 'B@Dominio.com', type: 'bounced', occurredAt }));

    expect(await statusesOf()).toEqual({ 'a@dominio.com': 'accepted', 'b@dominio.com': 'bounced' });
    expect(emails.listEvents()).toEqual([
      {
        emailId,
        recipient: 'b@dominio.com',
        provider: 'mailgun',
        type: 'bounced',
        raw: { event: 'delivered' },
        occurredAt,
        receivedAt: clock.now(),
      },
    ]);
  });

  it('correlates by provider message id when the internal id is missing', async () => {
    const { useCase, event, emails, emailId, statusesOf } = await setup();

    await useCase.execute(
      event({ messageId: undefined, providerMessageId: PROVIDER_MESSAGE_ID, type: 'delivered' }),
    );

    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'delivered' });
    expect(emails.listEvents()).toMatchObject([{ emailId }]);
  });

  it('records an event it cannot correlate with a null email id', async () => {
    const { useCase, event, emails, statusesOf } = await setup();

    await useCase.execute(event({ messageId: undefined, providerMessageId: 'unknown@mg' }));

    expect(emails.listEvents()).toMatchObject([{ emailId: null, recipient: 'a@dominio.com' }]);
    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'accepted' });
  });

  it('records out-of-order and duplicate events without moving the status back', async () => {
    const { useCase, event, emails, statusesOf } = await setup();

    await useCase.execute(event({ type: 'bounced' }));
    await useCase.execute(event({ type: 'delivered' }));
    await useCase.execute(event({ type: 'bounced' }));

    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'bounced' });
    expect(emails.listEvents().map((stored) => stored.type)).toEqual([
      'bounced',
      'delivered',
      'bounced',
    ]);
  });

  it('only records a temporary failure', async () => {
    const { useCase, event, emails, suppressions, statusesOf } = await setup();

    await useCase.execute(event({ type: 'temporary_failure' }));

    expect(emails.listEvents()).toHaveLength(1);
    expect(await statusesOf()).toMatchObject({ 'a@dominio.com': 'accepted' });
    expect(await suppressions.list()).toEqual([]);
  });

  describe('suppression', () => {
    it.each([
      ['bounced', 'bounce'],
      ['complained', 'complaint'],
      ['unsubscribed', 'unsubscribe'],
    ] as const)('suppresses the recipient of a %s event with reason %s', async (type, reason) => {
      const { useCase, event, suppressions } = await setup();

      await useCase.execute(event({ type, recipient: 'A@Dominio.com', provider: 'ses' }));

      expect(await suppressions.list()).toMatchObject([
        { email: 'a@dominio.com', reason, source: 'ses' },
      ]);
    });

    it('suppresses the recipient even when the event cannot be correlated', async () => {
      const { useCase, event, suppressions } = await setup();

      await useCase.execute(event({ type: 'bounced', messageId: undefined }));

      expect(await suppressions.findSuppressed(['a@dominio.com'])).toEqual(
        new Set(['a@dominio.com']),
      );
    });

    it('does not suppress the recipient of a delivered event', async () => {
      const { useCase, event, suppressions } = await setup();

      await useCase.execute(event({ type: 'delivered' }));

      expect(await suppressions.list()).toEqual([]);
    });
  });
});
