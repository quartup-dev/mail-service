import type { EmailMessage, SmtpServerConfig } from '../../domain/email';
import type { SendResult } from './send-result';

// Envío SMTP contra el servidor indicado en cada petición, conectando a la IP ya validada
export interface SmtpSender {
  send(
    message: EmailMessage,
    server: SmtpServerConfig,
    target: { ip: string },
  ): Promise<SendResult>;
}
