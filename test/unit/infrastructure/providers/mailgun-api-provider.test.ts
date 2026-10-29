import type { MailgunMessageData, MessagesSendResult } from 'mailgun.js/definitions';
import { describe, expect, it } from 'vitest';
import { PermanentProviderError, TransientProviderError } from '../../../../src/domain/errors';
import {
  MailgunApiProvider,
  mailgunClientOptions,
  type MailgunMessages,
} from '../../../../src/infrastructure/providers/mailgun-api-provider';
import { FakeClock } from '../../../support/fake-clock';
import { messageFrom } from '../../../support/email-messages';
import { apiRequest } from '../../../support/email-requests';

// Cliente simulado: registra las llamadas y responde como mailgun.js
class FakeMailgunMessages implements MailgunMessages {
  readonly calls: Array<{ domain: string; data: MailgunMessageData }> = [];
  failure: Error | null = null;

  async create(domain: string, data: MailgunMessageData): Promise<MessagesSendResult> {
    if (this.failure) throw this.failure;
    this.calls.push({ domain, data });
    return { id: '<20261029.abc@mg.example.com>', message: 'Queued. Thank you.', status: 200 };
  }
}

// Error HTTP como lo construye mailgun.js. Sin respuesta (red), axios no da estado y mailgun.js
// pone 400 con el código de error de Node como mensaje
function mailgunApiError(status: number, message: string, details = ''): Error {
  return Object.assign(new Error(message), { status, details, type: 'MailgunAPIError' });
}

function providerWith() {
  const messages = new FakeMailgunMessages();
  const clock = new FakeClock();
  const provider = new MailgunApiProvider({ messages, domain: 'mg.example.com', clock });
  return { provider, messages, clock };
}

describe('MailgunApiProvider', () => {
  it('maps the sender, recipients with their names, subject and bodies', async () => {
    const { provider, messages } = providerWith();
    const message = messageFrom(
      apiRequest({
        from: { email: 'notificaciones@example.com', name: 'José "Pepe" Pérez' },
        to: [{ email: 'a@dominio.com', name: 'Ana' }, { email: 'b@dominio.com' }],
        cc: [{ email: 'c@dominio.com' }],
        bcc: [{ email: 'd@dominio.com', name: 'Dani' }],
        subject: 'Factura',
        text: 'Hola',
        html: '<p>Hola</p>',
      }),
    );

    await provider.send(message);

    expect(messages.calls[0]?.data).toMatchObject({
      from: '"José \\"Pepe\\" Pérez" <notificaciones@example.com>',
      to: ['"Ana" <a@dominio.com>', 'b@dominio.com'],
      cc: ['c@dominio.com'],
      bcc: ['"Dani" <d@dominio.com>'],
      subject: 'Factura',
      text: 'Hola',
      html: '<p>Hola</p>',
    });
  });

  it('adds reply-to, custom headers, tags and the internal id as header and variable', async () => {
    const { provider, messages } = providerWith();
    const message = messageFrom(
      apiRequest({
        replyTo: { email: 'soporte@example.com', name: 'Soporte' },
        headers: { 'X-Campaign': 'otoño' },
        tags: ['factura', 'mensual'],
      }),
      '0192f0c4-0000-7000-8000-000000000001',
    );

    await provider.send(message);

    expect(messages.calls[0]?.data).toMatchObject({
      'h:Reply-To': '"Soporte" <soporte@example.com>',
      'h:X-Campaign': 'otoño',
      'h:X-Mail-Service-Id': '0192f0c4-0000-7000-8000-000000000001',
      'v:messageId': '0192f0c4-0000-7000-8000-000000000001',
      'o:tag': ['factura', 'mensual'],
    });
  });

  // En Mailgun el cid de una imagen inline es su nombre de fichero
  it('sends attachments with name and type, and inline ones named after their content id', async () => {
    const { provider, messages } = providerWith();
    const message = messageFrom(
      apiRequest({
        attachments: [
          { filename: 'factura.pdf', contentType: 'application/pdf', contentBase64: 'JVBERi0=' },
          {
            filename: 'logo.png',
            contentType: 'image/png',
            contentBase64: 'iVBORw0=',
            contentId: 'logo',
          },
        ],
      }),
    );

    await provider.send(message);

    expect(messages.calls[0]?.data).toMatchObject({
      attachment: [
        {
          filename: 'factura.pdf',
          contentType: 'application/pdf',
          data: Buffer.from('JVBERi0=', 'base64'),
        },
      ],
      inline: [
        { filename: 'logo', contentType: 'image/png', data: Buffer.from('iVBORw0=', 'base64') },
      ],
    });
  });

  // Los webhooks traen el message-id sin <>: se guarda igual para correlacionar
  it('sends to the configured domain and returns the id without angle brackets', async () => {
    const { provider, messages, clock } = providerWith();

    const result = await provider.send(messageFrom());

    expect(messages.calls[0]?.domain).toBe('mg.example.com');
    expect(result).toEqual({
      provider: 'mailgun',
      providerMessageId: '20261029.abc@mg.example.com',
      acceptedAt: clock.now(),
    });
  });

  // La supresión puede dejar vacío el to con destinatarios en cc o bcc; Mailgun exige to
  it('fails permanently without calling Mailgun when there is no to recipient', async () => {
    const { provider, messages } = providerWith();
    const message = messageFrom(apiRequest({ to: [], cc: [{ email: 'c@dominio.com' }] }));

    const sending = provider.send(message);

    await expect(sending).rejects.toBeInstanceOf(PermanentProviderError);
    await expect(sending).rejects.toMatchObject({
      provider: 'mailgun',
      code: 'MAILGUN_TO_REQUIRED',
    });
    expect(messages.calls).toHaveLength(0);
  });

  describe('error classification', () => {
    async function failureOf(error: Error) {
      const { provider, messages } = providerWith();
      messages.failure = error;
      return provider.send(messageFrom()).catch((failure: unknown) => failure);
    }

    it.each([429, 500, 502, 503])('treats HTTP %i as transient', async (status) => {
      const failure = await failureOf(mailgunApiError(status, 'Error'));

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ provider: 'mailgun', code: `MAILGUN_HTTP_${status}` });
    });

    it.each([400, 401, 403, 404])('treats HTTP %i as permanent', async (status) => {
      const failure = await failureOf(mailgunApiError(status, 'Error', 'to parameter is missing'));

      expect(failure).toBeInstanceOf(PermanentProviderError);
      expect(failure).toMatchObject({ provider: 'mailgun', code: `MAILGUN_HTTP_${status}` });
    });

    it.each([
      ['ECONNRESET', 'socket hang up'],
      ['ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443'],
      ['ENOTFOUND', 'getaddrinfo ENOTFOUND api.eu.mailgun.net'],
      ['ECONNABORTED', 'timeout of 30000ms exceeded'],
      ['ERR_NETWORK', 'Network Error'],
    ])('treats a network error without response (%s) as transient', async (code, details) => {
      const failure = await failureOf(mailgunApiError(400, code, details));

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ provider: 'mailgun', code: 'MAILGUN_NETWORK_ERROR' });
    });

    it('treats HTTP 408 as transient by default', async () => {
      const failure = await failureOf(mailgunApiError(408, 'Request Timeout'));

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ code: 'MAILGUN_HTTP_408' });
    });

    it.each([413, 422])('treats any other HTTP %i as permanent by default', async (status) => {
      const failure = await failureOf(mailgunApiError(status, 'Error'));

      expect(failure).toBeInstanceOf(PermanentProviderError);
      expect(failure).toMatchObject({ code: `MAILGUN_HTTP_${status}` });
    });

    it('treats a network error raised outside the HTTP layer as transient', async () => {
      const failure = await failureOf(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      );

      expect(failure).toBeInstanceOf(TransientProviderError);
      expect(failure).toMatchObject({ code: 'MAILGUN_NETWORK_ERROR' });
    });

    it('treats a local error, such as invalid data, as permanent', async () => {
      const failure = await failureOf(new TypeError('Invalid attachment'));

      expect(failure).toBeInstanceOf(PermanentProviderError);
      expect(failure).toMatchObject({ code: 'MAILGUN_ERROR', message: 'Invalid attachment' });
    });
  });
});

describe('mailgunClientOptions', () => {
  it.each([
    ['eu', 'https://api.eu.mailgun.net'],
    ['us', 'https://api.mailgun.net'],
  ] as const)('uses the %s region URL, the API key and a request timeout', (region, url) => {
    expect(mailgunClientOptions({ apiKey: 'not-a-real-key', region })).toEqual({
      username: 'api',
      key: 'not-a-real-key',
      url,
      timeout: 30_000,
    });
  });
});
