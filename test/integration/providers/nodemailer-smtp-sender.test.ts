import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { messageFrom } from '../../support/email-messages';
import { smtpRequest } from '../../support/email-requests';
import {
  MAILPIT_IP,
  MAILPIT_SERVER,
  mailpitSender,
  receivedHeaders,
  receivedMessage,
  receivedPart,
} from '../../support/mailpit';

const execFileAsync = promisify(execFile);

const PDF = Buffer.from('%PDF-1.4 factura de prueba');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

// Requiere docker compose up y NODE_EXTRA_CA_CERTS con la CA local (bun run test:integration)
describe('NodemailerSmtpSender against Mailpit', () => {
  const sender = mailpitSender();

  afterAll(() => sender.close());

  it('delivers over STARTTLS on port 587 with subject, bodies, attachments and the internal id', async () => {
    const subject = `Factura ${randomUUID()}`;
    const message = messageFrom(
      smtpRequest({
        from: { email: 'notificaciones@example.com', name: 'José Pérez' },
        to: [{ email: 'cliente@dominio.com', name: 'Ana' }],
        subject,
        text: 'Hola, adjuntamos la factura.',
        html: '<p>Hola, adjuntamos la factura.</p><img src="cid:logo">',
        attachments: [
          {
            filename: 'factura.pdf',
            contentType: 'application/pdf',
            contentBase64: PDF.toString('base64'),
          },
          {
            filename: 'logo.png',
            contentType: 'image/png',
            contentBase64: PNG.toString('base64'),
            contentId: 'logo',
          },
        ],
      }),
    );

    const result = await sender.send(message, MAILPIT_SERVER, { ip: MAILPIT_IP });

    expect(result.provider).toBe('smtp');
    const received = await receivedMessage(subject);
    expect(received).toMatchObject({
      Subject: subject,
      Text: 'Hola, adjuntamos la factura.',
      From: { Name: 'José Pérez', Address: 'notificaciones@example.com' },
      To: [{ Name: 'Ana', Address: 'cliente@dominio.com' }],
    });
    expect(received.HTML).toContain('<p>Hola, adjuntamos la factura.</p>');
    const [pdf] = received.Attachments;
    expect(pdf).toMatchObject({ FileName: 'factura.pdf', ContentType: 'application/pdf' });
    expect(await receivedPart(received.ID, pdf!.PartID)).toEqual(PDF);
    const [logo] = received.Inline;
    expect(logo).toMatchObject({
      FileName: 'logo.png',
      ContentType: 'image/png',
      ContentID: 'logo',
    });
    expect(await receivedPart(received.ID, logo!.PartID)).toEqual(PNG);
    expect((await receivedHeaders(received.ID))['X-Mail-Service-Id']).toEqual([message.id]);
  });

  it('fails with a permanent certificate error in a process without the local CA', async () => {
    const env = { ...process.env };
    delete env.NODE_EXTRA_CA_CERTS;

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../../support/send-to-mailpit.ts', import.meta.url)),
      ],
      { env },
    );

    expect(JSON.parse(stdout)).toEqual({
      sent: false,
      errorClass: 'PermanentProviderError',
      code: 'SMTP_TLS_CERTIFICATE_INVALID',
    });
  });
});
