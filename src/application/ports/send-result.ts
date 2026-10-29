import type { ProviderName } from '../../domain/email';

export interface SendResult {
  provider: ProviderName;
  providerMessageId: string;
  acceptedAt: Date;
  rejectedRecipients?: string[]; // solo SMTP: destinatarios rechazados en el RCPT TO
}
