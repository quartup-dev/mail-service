import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { SendMailOptions, SMTPPoolOptions } from 'nodemailer';
import type { Clock } from '../../application/ports/clock';
import type { SendResult } from '../../application/ports/send-result';
import type { SmtpSender } from '../../application/ports/smtp-sender';
import type { EmailMessage, SmtpServerConfig } from '../../domain/email';
import { toMailOptions } from './mail-options';
import { classifySmtpError } from './smtp-errors';

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

interface CachedTransport {
  transport: SmtpTransport;
  lastUsedAt: number; // ms; la entrada caduca tras transportCacheTtlMs sin uso
}

export class NodemailerSmtpSender implements SmtpSender {
  private readonly transports = new Map<string, CachedTransport>();

  constructor(private readonly deps: NodemailerSmtpSenderDeps) {}

  async send(
    message: EmailMessage,
    server: SmtpServerConfig,
    target: { ip: string },
  ): Promise<SendResult> {
    const transport = this.transportFor(server, target.ip);
    // DKIM por mensaje: la clave de la caché de transportes no la incluye
    const info = await transport
      .sendMail({ ...toMailOptions(message), ...(server.dkim && { dkim: { ...server.dkim } }) })
      .catch((error: unknown) => {
        throw classifySmtpError(error);
      });
    return {
      provider: 'smtp',
      providerMessageId: info.messageId,
      acceptedAt: this.deps.clock.now(),
      // Rechazos parciales en el RCPT TO; si los rechaza todos, Nodemailer lanza EENVELOPE
      ...(info.rejected.length > 0 && { rejectedRecipients: info.rejected }),
    };
  }

  // Apagado del worker: cierra todos los pools
  close(): void {
    for (const [key, entry] of this.transports) this.evict(key, entry);
  }

  private transportFor(server: SmtpServerConfig, ip: string): SmtpTransport {
    const now = this.deps.clock.now().getTime();
    this.evictUnusedSince(now - this.deps.settings.transportCacheTtlMs);
    const key = cacheKeyOf(server, ip);
    const cached = this.transports.get(key);
    if (cached) {
      // El Map conserva el orden de inserción: el primero es el usado hace más tiempo
      this.transports.delete(key);
      this.transports.set(key, { transport: cached.transport, lastUsedAt: now });
      return cached.transport;
    }
    if (this.transports.size >= this.deps.settings.transportCacheMax) this.evictLeastRecentlyUsed();
    const transport = this.deps.createTransport(transportOptions(server, ip, this.deps.settings));
    this.transports.set(key, { transport, lastUsedAt: now });
    return transport;
  }

  private evictUnusedSince(threshold: number): void {
    for (const [key, entry] of this.transports) {
      if (entry.lastUsedAt < threshold) this.evict(key, entry);
    }
  }

  private evictLeastRecentlyUsed(): void {
    const [oldest] = this.transports;
    if (oldest) this.evict(...oldest);
  }

  // Los envíos en curso terminan; los que esperan en el pool fallan sin código (transitorios)
  private evict(key: string, entry: CachedTransport): void {
    this.transports.delete(key);
    entry.transport.close();
  }
}

// Hash de host, IP, puerto y credenciales; la contraseña, también con hash
function cacheKeyOf(server: SmtpServerConfig, ip: string): string {
  const passHash = sha256(server.auth?.pass ?? '');
  return sha256(JSON.stringify([server.host, ip, server.port, server.auth?.user ?? '', passHash]));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
