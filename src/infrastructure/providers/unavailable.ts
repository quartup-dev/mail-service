import type { SmtpHostGuard } from '../../application/ports/smtp-host-guard';
import { SmtpHostNotAllowedError } from '../../domain/errors';

// Guard que rechaza todos los hosts. Lo usa la exportación de OpenAPI, que construye la app sin
// red: nunca debe resolver DNS
export class UnavailableSmtpHostGuard implements SmtpHostGuard {
  async resolveAndValidate(host: string): Promise<{ host: string; ip: string }> {
    throw new SmtpHostNotAllowedError(host, 'SMTP host validation is not available');
  }
}
