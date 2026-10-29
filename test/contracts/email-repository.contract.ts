import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AttemptRecord,
  EmailRepository,
  StoredEvent,
} from '../../src/application/ports/email-repository';
import { messageFrom } from '../support/email-messages';
import { apiRequest, smtpRequest } from '../support/email-requests';
import type { FakeClock } from '../support/fake-clock';

export interface EmailRepositoryContext {
  repository: EmailRepository;
  clock: FakeClock;
}

// Batería común a todas las implementaciones de EmailRepository (en memoria y Drizzle)
export function describeEmailRepositoryContract(
  name: string,
  createContext: () => Promise<EmailRepositoryContext>,
): void {
  describe(`${name} (EmailRepository contract)`, () => {
    let repository: EmailRepository;
    let clock: FakeClock;

    beforeEach(async () => {
      ({ repository, clock } = await createContext());
    });

    const createInput = (overrides: { clientId?: string; idempotencyKey?: string } = {}) => ({
      message: messageFrom(),
      clientId: 'billing',
      requestId: 'req-1',
      requestHash: 'hash-1',
      ...overrides,
    });

    describe('create', () => {
      it('stores the message as queued with its recipients pending, in lowercase and with their kind', async () => {
        const message = messageFrom(
          apiRequest({
            to: [{ email: 'Ana@Dominio.com' }],
            cc: [{ email: 'Luis@dominio.com' }],
            bcc: [{ email: 'audit@dominio.com' }],
          }),
        );

        const { email, created } = await repository.create({ ...createInput(), message });

        expect(created).toBe(true);
        expect(await repository.findById(message.id)).toEqual(email);
        expect(email).toMatchObject({
          id: message.id,
          clientId: 'billing',
          requestId: 'req-1',
          requestHash: 'hash-1',
          idempotencyKey: null,
          payload: message,
          transport: 'api',
          status: 'queued',
          provider: null,
          providerMessageId: null,
          createdAt: clock.now(),
          updatedAt: clock.now(),
          sentAt: null,
          attempts: [],
        });
        expect(email.recipients).toEqual([
          { email: 'ana@dominio.com', kind: 'to', status: 'pending', updatedAt: clock.now() },
          { email: 'luis@dominio.com', kind: 'cc', status: 'pending', updatedAt: clock.now() },
          { email: 'audit@dominio.com', kind: 'bcc', status: 'pending', updatedAt: clock.now() },
        ]);
      });

      it('stores the SMTP host, port and encrypted configuration', async () => {
        const message = messageFrom(smtpRequest());

        const { email } = await repository.create({
          ...createInput(),
          message,
          smtpConfigEncrypted: 'key-id:encrypted',
        });

        expect(email).toMatchObject({
          transport: 'smtp',
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpConfigEncrypted: 'key-id:encrypted',
        });
      });

      it('returns the existing message when the client repeats an idempotency key', async () => {
        const first = await repository.create(createInput({ idempotencyKey: 'key-1' }));

        const second = await repository.create(createInput({ idempotencyKey: 'key-1' }));

        expect(second).toEqual({ email: first.email, created: false });
      });

      it('creates a new message when another client uses the same idempotency key', async () => {
        await repository.create(createInput({ clientId: 'billing', idempotencyKey: 'key-1' }));

        const other = await repository.create(
          createInput({ clientId: 'crm', idempotencyKey: 'key-1' }),
        );

        expect(other.created).toBe(true);
        expect(other.email.clientId).toBe('crm');
      });
    });

    describe('findById', () => {
      it('returns null for an unknown id', async () => {
        expect(await repository.findById('0192f0c4-0000-7000-8000-000000000000')).toBeNull();
      });

      it('returns a copy that does not change the stored message when modified', async () => {
        const { email } = await repository.create(createInput());

        email.status = 'sent';
        email.recipients[0]!.status = 'delivered';

        expect(await repository.findById(email.id)).toMatchObject({
          status: 'queued',
          recipients: [{ status: 'pending' }],
        });
      });
    });

    describe('findByProviderMessageId', () => {
      it('finds a message by provider and provider message id', async () => {
        const { email } = await repository.create(createInput());
        await repository.create(createInput());
        await repository.updateStatus(email.id, 'sent', {
          provider: 'mailgun',
          providerMessageId: '20261029.abc@mg.example.com',
        });

        expect(
          (await repository.findByProviderMessageId('mailgun', '20261029.abc@mg.example.com'))?.id,
        ).toBe(email.id);
        expect(
          await repository.findByProviderMessageId('ses', '20261029.abc@mg.example.com'),
        ).toBeNull();
      });
    });

    describe('updateStatus', () => {
      it('applies the status, the patch and the update time', async () => {
        const { email } = await repository.create(createInput());
        clock.advance(1_000);

        await repository.updateStatus(email.id, 'failed', {
          errorCode: 'EXPIRED',
          errorMessage: 'Pending for too long',
          smtpConfigEncrypted: null,
        });

        expect(await repository.findById(email.id)).toMatchObject({
          status: 'failed',
          errorCode: 'EXPIRED',
          errorMessage: 'Pending for too long',
          smtpConfigEncrypted: null,
          createdAt: email.createdAt,
          updatedAt: clock.now(),
        });
      });
    });

    describe('recordAttempt', () => {
      it('appends attempts in order', async () => {
        const { email } = await repository.create(createInput());
        const attempt = (number: number): AttemptRecord => ({
          attempt: number,
          transport: 'api',
          provider: 'mailgun',
          outcome: number === 1 ? 'transient_error' : 'success',
          code: number === 1 ? '429' : null,
          message: null,
          durationMs: 120,
          createdAt: clock.now(),
        });

        await repository.recordAttempt(email.id, attempt(1));
        await repository.recordAttempt(email.id, attempt(2));

        expect((await repository.findById(email.id))?.attempts).toEqual([attempt(1), attempt(2)]);
      });
    });

    describe('recipient statuses', () => {
      const twoRecipients = () =>
        messageFrom(apiRequest({ to: [{ email: 'a@dominio.com' }, { email: 'b@dominio.com' }] }));

      const statusesOf = async (id: string) =>
        Object.fromEntries(
          ((await repository.findById(id))?.recipients ?? []).map((r) => [r.email, r.status]),
        );

      it('setRecipientStatuses advances each recipient and stamps the update time', async () => {
        const { email } = await repository.create({ ...createInput(), message: twoRecipients() });
        clock.advance(1_000);

        await repository.setRecipientStatuses(email.id, [
          { email: 'a@dominio.com', status: 'accepted' },
          { email: 'b@dominio.com', status: 'rejected' },
        ]);

        const stored = await repository.findById(email.id);
        expect(stored?.recipients).toEqual([
          { email: 'a@dominio.com', kind: 'to', status: 'accepted', updatedAt: clock.now() },
          { email: 'b@dominio.com', kind: 'to', status: 'rejected', updatedAt: clock.now() },
        ]);
      });

      it('setRecipientStatuses does not move a recipient back to a lower rank', async () => {
        const { email } = await repository.create({ ...createInput(), message: twoRecipients() });
        await repository.advanceRecipientStatus(
          email.id,
          'a@dominio.com',
          'delivered',
          clock.now(),
        );

        await repository.setRecipientStatuses(email.id, [
          { email: 'a@dominio.com', status: 'accepted' },
          { email: 'b@dominio.com', status: 'accepted' },
        ]);

        expect(await statusesOf(email.id)).toEqual({
          'a@dominio.com': 'delivered',
          'b@dominio.com': 'accepted',
        });
      });

      it('advanceRecipientStatus applies a higher rank and stamps the event time', async () => {
        const { email } = await repository.create({ ...createInput(), message: twoRecipients() });
        const occurredAt = new Date('2026-10-29T10:05:00.000Z');

        const applied = await repository.advanceRecipientStatus(
          email.id,
          'b@dominio.com',
          'bounced',
          occurredAt,
        );

        expect(applied).toBe(true);
        expect((await repository.findById(email.id))?.recipients[1]).toEqual({
          email: 'b@dominio.com',
          kind: 'to',
          status: 'bounced',
          updatedAt: occurredAt,
        });
        expect(await statusesOf(email.id)).toMatchObject({ 'a@dominio.com': 'pending' });
      });

      it('advanceRecipientStatus ignores a lower or equal rank', async () => {
        const { email } = await repository.create({ ...createInput(), message: twoRecipients() });
        await repository.advanceRecipientStatus(email.id, 'a@dominio.com', 'bounced', clock.now());

        const lower = await repository.advanceRecipientStatus(
          email.id,
          'a@dominio.com',
          'delivered',
          clock.now(),
        );
        const equal = await repository.advanceRecipientStatus(
          email.id,
          'a@dominio.com',
          'complained',
          clock.now(),
        );

        expect([lower, equal]).toEqual([false, false]);
        expect(await statusesOf(email.id)).toMatchObject({ 'a@dominio.com': 'bounced' });
      });

      it('advanceRecipientStatus returns false for an unknown recipient or message', async () => {
        const { email } = await repository.create({ ...createInput(), message: twoRecipients() });

        expect(
          await repository.advanceRecipientStatus(
            email.id,
            'x@dominio.com',
            'delivered',
            clock.now(),
          ),
        ).toBe(false);
        expect(
          await repository.advanceRecipientStatus(
            '0192f0c4-0000-7000-8000-000000000000',
            'a@dominio.com',
            'delivered',
            clock.now(),
          ),
        ).toBe(false);
      });
    });

    describe('findPending', () => {
      const MINUTE = 60_000;

      it('returns queued and sending messages created before the date, oldest first', async () => {
        const queued = await repository.create(createInput());
        clock.advance(MINUTE);
        const sending = await repository.create(createInput());
        await repository.updateStatus(sending.email.id, 'sending');
        clock.advance(MINUTE);
        const sent = await repository.create(createInput());
        await repository.updateStatus(sent.email.id, 'sent');
        clock.advance(MINUTE);
        await repository.create(createInput()); // demasiado reciente

        const pending = await repository.findPending({ createdBefore: clock.now() }, 10);

        expect(pending.map((email) => email.id)).toEqual([queued.email.id, sending.email.id]);
      });

      it('filters by last update', async () => {
        const stale = await repository.create(createInput());
        const active = await repository.create(createInput());
        clock.advance(10 * MINUTE);
        await repository.updateStatus(active.email.id, 'sending');

        const pending = await repository.findPending({ updatedBefore: clock.now() }, 10);

        expect(pending.map((email) => email.id)).toEqual([stale.email.id]);
      });

      it('returns at most the limit', async () => {
        for (let i = 0; i < 3; i++) await repository.create(createInput());
        clock.advance(MINUTE);

        expect(await repository.findPending({ createdBefore: clock.now() }, 2)).toHaveLength(2);
      });
    });

    describe('retention', () => {
      const DAY = 86_400_000;
      const FAR_FUTURE = new Date('2100-01-01T00:00:00.000Z');

      const event = (emailId: string | null): StoredEvent => ({
        emailId,
        recipient: 'cliente@dominio.com',
        provider: 'mailgun',
        type: 'delivered',
        raw: { event: 'delivered' },
        occurredAt: clock.now(),
        receivedAt: clock.now(),
      });

      const createFinal = async () => {
        const { email } = await repository.create(createInput());
        await repository.updateStatus(email.id, 'sent');
        return email;
      };

      it('deleteEvents removes events received before the date, up to the limit', async () => {
        await repository.recordEvent(event(null));
        await repository.recordEvent(event(null));
        await repository.recordEvent(event(null));
        clock.advance(DAY);
        await repository.recordEvent(event(null));

        expect(await repository.deleteEvents(clock.now(), 2)).toBe(2);
        expect(await repository.deleteEvents(clock.now(), 2)).toBe(1);
        expect(await repository.deleteEvents(FAR_FUTURE, 10)).toBe(1);
      });

      it('clearPayloads empties the payload of final messages before the date, up to the limit', async () => {
        const first = await createFinal();
        const second = await createFinal();
        const pending = await repository.create(createInput());
        clock.advance(DAY);
        const recent = await createFinal();

        expect(await repository.clearPayloads(clock.now(), 1)).toBe(1);
        expect(await repository.clearPayloads(clock.now(), 10)).toBe(1);
        expect(await repository.clearPayloads(clock.now(), 10)).toBe(0);

        const payloads = await Promise.all(
          [first, second, pending.email, recent].map(
            async (e) => (await repository.findById(e.id))?.payload,
          ),
        );
        expect(payloads.map((payload) => payload === null)).toEqual([true, true, false, false]);
      });

      it('deleteFinalEmails removes final messages created before the date, with their events', async () => {
        const old = await createFinal();
        await repository.recordEvent(event(old.id));
        const pending = await repository.create(createInput());
        clock.advance(DAY);
        const recent = await createFinal();
        await repository.recordEvent(event(recent.id));

        expect(await repository.deleteFinalEmails(clock.now(), 10)).toBe(1);

        expect(await repository.findById(old.id)).toBeNull();
        expect(await repository.findById(pending.email.id)).not.toBeNull();
        expect(await repository.findById(recent.id)).not.toBeNull();
        expect(await repository.deleteEvents(FAR_FUTURE, 10)).toBe(1);
      });

      it('deleteFinalEmails processes at most the limit', async () => {
        for (let i = 0; i < 3; i++) await createFinal();
        clock.advance(DAY);

        expect(await repository.deleteFinalEmails(clock.now(), 2)).toBe(2);
        expect(await repository.deleteFinalEmails(clock.now(), 2)).toBe(1);
      });
    });

    describe('concurrency', () => {
      it('creates a single message when the same idempotency key arrives in parallel', async () => {
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            repository.create({
              ...createInput({ idempotencyKey: 'key-1' }),
              message: messageFrom(),
            }),
          ),
        );

        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(new Set(results.map((result) => result.email.id)).size).toBe(1);
      });

      it('never moves a recipient back with parallel updates', async () => {
        const { email } = await repository.create(createInput());
        const recipient = email.recipients[0]?.email ?? '';
        const at = clock.now();

        await Promise.all([
          repository.advanceRecipientStatus(email.id, recipient, 'delivered', at),
          repository.setRecipientStatuses(email.id, [{ email: recipient, status: 'accepted' }]),
          repository.advanceRecipientStatus(email.id, recipient, 'bounced', at),
          repository.setRecipientStatuses(email.id, [{ email: recipient, status: 'accepted' }]),
          repository.advanceRecipientStatus(email.id, recipient, 'delivered', at),
        ]);

        expect((await repository.findById(email.id))?.recipients[0]?.status).toBe('bounced');
      });
    });
  });
}
