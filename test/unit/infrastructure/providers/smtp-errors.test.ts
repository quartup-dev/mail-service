import { describe, expect, it } from 'vitest';
import { PermanentProviderError, TransientProviderError } from '../../../../src/domain/errors';
import { classifySmtpError } from '../../../../src/infrastructure/providers/smtp-errors';

// Errores con la forma que les da Nodemailer: code propio, responseCode de la respuesta SMTP
// y originalCode con el código de Node cuando falla el socket
function nodemailerError(
  fields: { code?: string; responseCode?: number; originalCode?: string },
  message = 'SMTP error',
): Error {
  return Object.assign(new Error(message), fields);
}

describe('classifySmtpError', () => {
  it.each([421, 450, 451, 452])('treats an SMTP %i reply as transient', (responseCode) => {
    const error = classifySmtpError(nodemailerError({ code: 'EENVELOPE', responseCode }));

    expect(error).toBeInstanceOf(TransientProviderError);
    expect(error).toMatchObject({ provider: 'smtp', code: `SMTP_${responseCode}` });
  });

  it.each([550, 553, 554])('treats an SMTP %i reply as permanent', (responseCode) => {
    const error = classifySmtpError(nodemailerError({ code: 'EMESSAGE', responseCode }));

    expect(error).toBeInstanceOf(PermanentProviderError);
    expect(error).toMatchObject({ provider: 'smtp', code: `SMTP_${responseCode}` });
  });

  it.each([
    { case: 'EAUTH with a temporary reply', fields: { code: 'EAUTH', responseCode: 454 } },
    { case: 'EAUTH without a reply', fields: { code: 'EAUTH' } },
    { case: 'a 535 reply', fields: { code: 'EENVELOPE', responseCode: 535 } },
  ])('treats an authentication failure ($case) as permanent', ({ fields }) => {
    const error = classifySmtpError(nodemailerError(fields));

    expect(error).toBeInstanceOf(PermanentProviderError);
    expect(error.code).toBe('SMTP_AUTH_FAILED');
  });

  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('treats an invalid TLS certificate (%s) as permanent', (originalCode) => {
    const error = classifySmtpError(nodemailerError({ code: 'ESOCKET', originalCode }));

    expect(error).toBeInstanceOf(PermanentProviderError);
    expect(error.code).toBe('SMTP_TLS_CERTIFICATE_INVALID');
  });

  describe('when every recipient is rejected (EENVELOPE)', () => {
    it('treats it as permanent if the rejections are permanent', () => {
      const error = classifySmtpError(nodemailerError({ code: 'EENVELOPE', responseCode: 550 }));

      expect(error).toBeInstanceOf(PermanentProviderError);
      expect(error.code).toBe('SMTP_550');
    });

    // Nodemailer pone en responseCode la respuesta 4xx si alguno de los rechazos lo fue
    it('treats it as transient if some rejection was temporary', () => {
      const error = classifySmtpError(nodemailerError({ code: 'EENVELOPE', responseCode: 450 }));

      expect(error).toBeInstanceOf(TransientProviderError);
      expect(error.code).toBe('SMTP_450');
    });

    it('treats it as permanent without a server reply', () => {
      const error = classifySmtpError(nodemailerError({ code: 'EENVELOPE' }));

      expect(error).toBeInstanceOf(PermanentProviderError);
      expect(error.code).toBe('SMTP_RECIPIENTS_REJECTED');
    });
  });

  it.each([
    { case: 'a timeout', fields: { code: 'ETIMEDOUT' } },
    { case: 'a reset connection', fields: { code: 'ESOCKET', originalCode: 'ECONNRESET' } },
    { case: 'a refused connection', fields: { code: 'ESOCKET', originalCode: 'ECONNREFUSED' } },
    { case: 'a DNS failure', fields: { code: 'EDNS' } },
    { case: 'a closed connection', fields: { code: 'ECONNECTION' } },
  ])('treats a network error ($case) as transient', ({ fields }) => {
    const error = classifySmtpError(nodemailerError(fields));

    expect(error).toBeInstanceOf(TransientProviderError);
    expect(error.code).toBe('SMTP_NETWORK_ERROR');
  });

  // Nodemailer rechaza sin código los envíos en cola de un pool que se cierra
  it('treats an error without code, such as a closed pool, as transient', () => {
    const error = classifySmtpError(nodemailerError({}, 'Connection pool was closed'));

    expect(error).toBeInstanceOf(TransientProviderError);
    expect(error).toMatchObject({ code: 'SMTP_ERROR', message: 'Connection pool was closed' });
  });

  it.each(['EMESSAGE', 'EPROTOCOL', 'ETLS', 'ECONFIG'])(
    'treats any other Nodemailer error (%s) as permanent',
    (code) => {
      const error = classifySmtpError(nodemailerError({ code }));

      expect(error).toBeInstanceOf(PermanentProviderError);
      expect(error.code).toBe(`SMTP_${code}`);
    },
  );
});
