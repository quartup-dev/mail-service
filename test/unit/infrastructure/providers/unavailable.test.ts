import { describe, expect, it } from 'vitest';
import type { SmtpHostGuard } from '../../../../src/application/ports/smtp-host-guard';
import type { SmtpSender } from '../../../../src/application/ports/smtp-sender';
import { PermanentProviderError, SmtpHostNotAllowedError } from '../../../../src/domain/errors';
import {
  UnavailableSmtpHostGuard,
  UnavailableSmtpSender,
} from '../../../../src/infrastructure/providers/unavailable';
import { messageFrom } from '../../../support/email-messages';
import { smtpRequest } from '../../../support/email-requests';

describe('unavailable SMTP adapters', () => {
  it('the host guard rejects every host', async () => {
    const guard: SmtpHostGuard = new UnavailableSmtpHostGuard();

    await expect(guard.resolveAndValidate('smtp.example.com', 587)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });

  it('the sender fails with a permanent error', async () => {
    const sender: SmtpSender = new UnavailableSmtpSender();

    await expect(
      sender.send(
        messageFrom(smtpRequest()),
        { host: 'smtp.example.com', port: 587 },
        { ip: '203.0.113.10' },
      ),
    ).rejects.toMatchObject({ constructor: PermanentProviderError, code: 'NOT_IMPLEMENTED' });
  });
});
