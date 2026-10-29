import { isIP } from 'node:net';
import type { SendMailOptions, SMTPPoolOptions } from 'nodemailer';
import type { Clock } from '../../application/ports/clock';
import type { SendResult } from '../../application/ports/send-result';
import type { SmtpSender } from '../../application/ports/smtp-sender';
import type { EmailMessage, SmtpServerConfig } from '../../domain/email';
import { toMailOptions } from './mail-options';

// Lo que usamos de un transporte de Nodemailer: el test lo sustituye en la frontera
export interface SmtpTransport {
  sendMail(mail: SendMailOptions): Promise<{ messageId: string; rejected: string[] }>;
  close(): void;
}

export type CreateSmtpTransport = (options: SMTPPoolOptions) => SmtpTransport;

export interface SmtpSenderSettings {
  poolMaxConnections: number;
  rateLimitPerSecond: number;
  transportCacheTtlMs: number;
  transportCacheMax: number;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
}

export interface NodemailerSmtpSenderDeps {
  createTransport: CreateSmtpTransport;
  clock: Clock;
  settings: SmtpSenderSettings;
}

export class NodemailerSmtpSender implements SmtpSender {
  constructor(private readonly deps: NodemailerSmtpSenderDeps) {}

  async send(
    message: EmailMessage,
    server: SmtpServerConfig,
    target: { ip: string },
  ): Promise<SendResult> {
    const transport = this.deps.createTransport(
      transportOptions(server, target.ip, this.deps.settings),
    );
    // DKIM por mensaje: la clave de la caché de transportes no la incluye
    const info = await transport.sendMail({
      ...toMailOptions(message),
      ...(server.dkim && { dkim: { ...server.dkim } }),
    });
    return {
      provider: 'smtp',
      providerMessageId: info.messageId,
      acceptedAt: this.deps.clock.now(),
      // Rechazos parciales en el RCPT TO; si los rechaza todos, Nodemailer lanza EENVELOPE
      ...(info.rejected.length > 0 && { rejectedRecipients: info.rejected }),
    };
  }
}

function transportOptions(
  server: SmtpServerConfig,
  ip: string,
  settings: SmtpSenderSettings,
): SMTPPoolOptions {
  return {
    pool: true,
    maxConnections: settings.poolMaxConnections,
    rateLimit: settings.rateLimitPerSecond,
    rateDelta: 1000,
    connectionTimeout: settings.connectionTimeoutMs,
    greetingTimeout: settings.greetingTimeoutMs,
    socketTimeout: settings.socketTimeoutMs,
    // Los reintentos los gestiona solo la cola
    maxRequeues: 0,
    host: ip,
    port: server.port,
    // 465: TLS implícito; 587: STARTTLS obligatorio
    ...(server.port === 465 ? { secure: true } : { secure: false, requireTLS: true }),
    // SNI y verificación del certificado con el nombre original, no con la IP
    tls: { ...(isIP(server.host) === 0 && { servername: server.host }), rejectUnauthorized: true },
    ...(server.auth && { auth: { user: server.auth.user, pass: server.auth.pass } }),
  };
}
