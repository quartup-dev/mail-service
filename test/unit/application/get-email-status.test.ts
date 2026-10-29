import { describe, expect, it } from 'vitest';
import { GetEmailStatus } from '../../../src/application/get-email-status';
import { InMemoryEmailRepository } from '../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { messageFrom } from '../../support/email-messages';
import { FakeClock } from '../../support/fake-clock';

async function setup() {
  const emails = new InMemoryEmailRepository(new FakeClock());
  const { email } = await emails.create({
    message: messageFrom(),
    clientId: 'billing',
    requestId: 'req-1',
    requestHash: 'hash-1',
  });
  return { useCase: new GetEmailStatus({ emails }), email };
}

describe('GetEmailStatus', () => {
  it('returns a message to the client that sent it', async () => {
    const { useCase, email } = await setup();

    expect(await useCase.execute({ clientId: 'billing', emailId: email.id })).toEqual(email);
  });

  it("returns not found for another client's message", async () => {
    const { useCase, email } = await setup();

    expect(await useCase.execute({ clientId: 'crm', emailId: email.id })).toBeNull();
  });

  it('returns not found for an unknown message', async () => {
    const { useCase } = await setup();

    expect(
      await useCase.execute({ clientId: 'billing', emailId: '0192f0c4-0000-7000-8000-999999999999' }),
    ).toBeNull();
  });
});
