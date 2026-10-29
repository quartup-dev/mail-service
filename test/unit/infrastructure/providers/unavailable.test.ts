import { describe, expect, it } from 'vitest';
import type { SmtpHostGuard } from '../../../../src/application/ports/smtp-host-guard';
import { SmtpHostNotAllowedError } from '../../../../src/domain/errors';
import { UnavailableSmtpHostGuard } from '../../../../src/infrastructure/providers/unavailable';

describe('UnavailableSmtpHostGuard', () => {
  it('rejects every host', async () => {
    const guard: SmtpHostGuard = new UnavailableSmtpHostGuard();

    await expect(guard.resolveAndValidate('smtp.example.com', 587)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });
});
