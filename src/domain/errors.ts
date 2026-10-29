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
