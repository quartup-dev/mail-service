import type { SendResult } from '../../application/ports/send-result';
import type { SmtpHostGuard } from '../../application/ports/smtp-host-guard';
import type { SmtpSender } from '../../application/ports/smtp-sender';
import { PermanentProviderError, SmtpHostNotAllowedError } from '../../domain/errors';

// Provisionales hasta las fases 3 (SmtpHostGuard con DNS) y 4 (envío con Nodemailer): fallan
// siempre, sin reintentos, para que ningún mensaje quede a medias
export class UnavailableSmtpHostGuard implements SmtpHostGuard {
  async resolveAndValidate(host: string): Promise<{ host: string; ip: string }> {
    throw new SmtpHostNotAllowedError(host, 'SMTP host validation is not implemented yet');
  }
}

export class UnavailableSmtpSender implements SmtpSender {
  async send(): Promise<SendResult> {
    throw new PermanentProviderError(
      'SMTP sending is not implemented yet',
      'smtp',
      'NOT_IMPLEMENTED',
    );
  }
}
