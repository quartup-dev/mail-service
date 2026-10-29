import { describe, expect, it } from 'vitest';
import { toMailOptions } from '../../../../src/infrastructure/providers/mail-options';
import { messageFrom } from '../../../support/email-messages';
import { apiRequest } from '../../../support/email-requests';

describe('toMailOptions', () => {
  it('keeps the name and address of the sender, recipients and reply-to', () => {
    const message = messageFrom(
      apiRequest({
        from: { email: 'notificaciones@example.com', name: 'José Pérez' },
        to: [{ email: 'a@dominio.com', name: 'Ana' }, { email: 'b@dominio.com' }],
        cc: [{ email: 'c@dominio.com', name: 'Carla' }],
        bcc: [{ email: 'd@dominio.com' }],
        replyTo: { email: 'soporte@example.com', name: 'Soporte' },
      }),
    );

    const options = toMailOptions(message);

    expect(options).toMatchObject({
      from: { name: 'José Pérez', address: 'notificaciones@example.com' },
      to: [
        { name: 'Ana', address: 'a@dominio.com' },
        { name: '', address: 'b@dominio.com' },
      ],
      cc: [{ name: 'Carla', address: 'c@dominio.com' }],
      bcc: [{ name: '', address: 'd@dominio.com' }],
      replyTo: { name: 'Soporte', address: 'soporte@example.com' },
    });
  });

  it('keeps the subject and both bodies', () => {
    const message = messageFrom(
      apiRequest({ subject: 'Factura', text: 'Hola', html: '<p>Hola</p>' }),
    );

    expect(toMailOptions(message)).toMatchObject({
      subject: 'Factura',
      text: 'Hola',
      html: '<p>Hola</p>',
    });
  });

  it('passes base64 attachments with their name and type, and the cid of inline ones', () => {
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

    expect(toMailOptions(message).attachments).toEqual([
      {
        filename: 'factura.pdf',
        contentType: 'application/pdf',
        content: 'JVBERi0=',
        encoding: 'base64',
      },
      {
        filename: 'logo.png',
        contentType: 'image/png',
        content: 'iVBORw0=',
        encoding: 'base64',
        cid: 'logo',
      },
    ]);
  });

  it('adds the custom headers and X-Mail-Service-Id with the internal id', () => {
    const message = messageFrom(
      apiRequest({ headers: { 'X-Campaign': 'otoño' } }),
      '0192f0c4-0000-7000-8000-000000000001',
    );

    expect(toMailOptions(message).headers).toEqual({
      'X-Campaign': 'otoño',
      'X-Mail-Service-Id': '0192f0c4-0000-7000-8000-000000000001',
    });
  });

  it('forbids reading attachment content from files or URLs', () => {
    expect(toMailOptions(messageFrom())).toMatchObject({
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });
});
