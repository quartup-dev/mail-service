import type { ProviderName } from './email';

export abstract class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

// Reintentable
export class TransientProviderError extends ProviderError {}

// No reintentar
export class PermanentProviderError extends ProviderError {}

// El texto cifrado no se puede descifrar con ninguna de las claves disponibles
export class UndecryptableSecretError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UndecryptableSecretError';
  }
}

export type EmailRequestRejectionCode =
  | 'TRANSPORT_NOT_ALLOWED'
  | 'API_TRANSPORT_NOT_CONFIGURED'
  | 'FROM_DOMAIN_NOT_ALLOWED'
  | 'SMTP_HOST_NOT_ALLOWED'
  | 'IDEMPOTENCY_CONFLICT';

// La petición es válida, pero la política o la configuración impiden atenderla
export class EmailRequestRejectedError extends Error {
  constructor(
    readonly code: EmailRequestRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SmtpHostNotAllowedError extends EmailRequestRejectedError {
  constructor(
    readonly host: string,
    reason: string,
  ) {
    super('SMTP_HOST_NOT_ALLOWED', `SMTP host ${host} is not allowed: ${reason}`);
  }
}
