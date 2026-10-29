import type { MailgunMessageData, MessagesSendResult } from 'mailgun.js/definitions';
import { describe, expect, it } from 'vitest';
import { PermanentProviderError } from '../../../../src/domain/errors';
import {
  MailgunApiProvider,
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
});
