import type { ApiProviderName, EmailMessage } from '../../domain/email';
import type { SendResult } from './send-result';

// Proveedor de API configurado globalmente (Mailgun, SES...)
export interface EmailApiProvider {
  readonly name: ApiProviderName;
  send(message: EmailMessage): Promise<SendResult>; // lanza ProviderError
  verify?(): Promise<void>; // comprobación en /ready
}
