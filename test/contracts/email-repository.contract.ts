import { beforeEach, describe, expect, it } from 'vitest';
import type { EmailRepository } from '../../src/application/ports/email-repository';
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

        const other = await repository.create(createInput({ clientId: 'crm', idempotencyKey: 'key-1' }));

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
  });
}
