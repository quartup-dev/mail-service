import type { SendMailOptions, SMTPPoolOptions } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import type { SmtpServerConfig } from '../../../../src/domain/email';
import {
  NodemailerSmtpSender,
  type SmtpSenderSettings,
  type SmtpTransport,
} from '../../../../src/infrastructure/providers/nodemailer-smtp-sender';
import { FakeClock } from '../../../support/fake-clock';
import { messageFrom } from '../../../support/email-messages';
import { smtpRequest } from '../../../support/email-requests';

const SETTINGS: SmtpSenderSettings = {
  poolMaxConnections: 3,
  rateLimitPerSecond: 7,
  transportCacheTtlMs: 60_000,
  transportCacheMax: 2,
  connectionTimeoutMs: 1_000,
  greetingTimeoutMs: 2_000,
  socketTimeoutMs: 3_000,
};

const SERVER: SmtpServerConfig = {
  host: 'smtp.example.com',
  port: 587,
  auth: { user: 'notificaciones@example.com', pass: 'not-a-real-password' },
};

const IP = '93.184.215.14';

// Transporte simulado: registra sus opciones y los correos, y responde como Nodemailer
class FakeTransport implements SmtpTransport {
  readonly mails: SendMailOptions[] = [];
  closed = false;
  rejected: string[] = [];
  failure: Error | null = null;

  constructor(readonly options: SMTPPoolOptions) {}

  async sendMail(mail: SendMailOptions) {
    if (this.failure) throw this.failure;
    this.mails.push(mail);
    return { messageId: `<${this.mails.length}@example.com>`, rejected: this.rejected };
  }

  close(): void {
    this.closed = true;
  }
}

function senderWith(
  settings: Partial<SmtpSenderSettings> = {},
  setUp: (transport: FakeTransport) => void = () => {},
) {
  const transports: FakeTransport[] = [];
  const clock = new FakeClock();
  const sender = new NodemailerSmtpSender({
    createTransport: (options) => {
      const transport = new FakeTransport(options);
      setUp(transport);
      transports.push(transport);
      return transport;
    },
    clock,
    settings: { ...SETTINGS, ...settings },
  });
  return { sender, transports, clock };
}

const message = messageFrom(smtpRequest());

describe('NodemailerSmtpSender', () => {
  it('connects to the validated IP and verifies the certificate against the original host', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, SERVER, { ip: IP });

    expect(transports[0]?.options).toMatchObject({
      host: IP,
      tls: { servername: 'smtp.example.com', rejectUnauthorized: true },
    });
  });

  it.each([IP, '2606:2800:220:1:248:1893:25c8:1946'])(
    'does not set servername when the host is the IP literal %s',
    async (ip) => {
      const { sender, transports } = senderWith();

      await sender.send(message, { ...SERVER, host: ip }, { ip });

      expect(transports[0]?.options.host).toBe(ip);
      expect(transports[0]?.options.tls).toEqual({ rejectUnauthorized: true });
    },
  );

  it('uses implicit TLS on port 465', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, { ...SERVER, port: 465 }, { ip: IP });

    expect(transports[0]?.options).toMatchObject({ port: 465, secure: true });
    expect(transports[0]?.options.requireTLS).toBeUndefined();
  });

  it('requires STARTTLS on port 587', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, { ...SERVER, port: 587 }, { ip: IP });

    expect(transports[0]?.options).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  // Los reintentos son solo de la cola: el pool no re-encola por su cuenta
  it('creates a pool limited per server, with the configured timeouts and no requeues', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, SERVER, { ip: IP });

    expect(transports[0]?.options).toMatchObject({
      pool: true,
      maxConnections: 3,
      rateLimit: 7,
      rateDelta: 1000,
      connectionTimeout: 1_000,
      greetingTimeout: 2_000,
      socketTimeout: 3_000,
      maxRequeues: 0,
    });
  });

  it('authenticates with the credentials of the request', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, SERVER, { ip: IP });

    expect(transports[0]?.options.auth).toEqual({
      user: 'notificaciones@example.com',
      pass: 'not-a-real-password',
    });
  });

  it('does not authenticate when the request has no credentials', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, { host: SERVER.host, port: 587 }, { ip: IP });

    expect(transports[0]?.options).not.toHaveProperty('auth');
  });

  it('signs with DKIM per message, never on the transport', async () => {
    const { sender, transports } = senderWith();
    const dkim = {
      domainName: 'example.com',
      keySelector: 'mail',
      privateKey: 'not-a-real-key',
    };

    await sender.send(message, { ...SERVER, dkim }, { ip: IP });

    expect(transports[0]?.options).not.toHaveProperty('dkim');
    expect(transports[0]?.mails[0]?.dkim).toEqual(dkim);
  });

  it('sends the mapped message', async () => {
    const { sender, transports } = senderWith();

    await sender.send(message, SERVER, { ip: IP });

    expect(transports[0]?.mails[0]).toMatchObject({
      subject: message.subject,
      headers: { 'X-Mail-Service-Id': message.id },
    });
  });

  it('returns the message id from the server and the time of the clock', async () => {
    const { sender, clock } = senderWith();

    const result = await sender.send(message, SERVER, { ip: IP });

    expect(result).toEqual({
      provider: 'smtp',
      providerMessageId: '<1@example.com>',
      acceptedAt: clock.now(),
    });
  });

  it('reports the recipients rejected at RCPT TO when others were accepted', async () => {
    const { sender } = senderWith({}, (transport) => {
      transport.rejected = ['malo@dominio.com'];
    });

    const result = await sender.send(message, SERVER, { ip: IP });

    expect(result.rejectedRecipients).toEqual(['malo@dominio.com']);
  });
});
