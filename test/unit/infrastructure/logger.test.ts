import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/infrastructure/logger';

const SECRET = 'super-secret-value';

function captureLogs(level: Parameters<typeof createLogger>[0]['level'] = 'info') {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level }, destination);
  return { logger, output: () => lines.join('') };
}

describe('createLogger', () => {
  it.each([
    ['the authorization header of a request', { req: { headers: { authorization: SECRET } } }],
    ['a top-level authorization field', { authorization: SECRET }],
    ['the SMTP password at the root', { smtp: { auth: { user: 'u', pass: SECRET } } }],
    ['the SMTP password one level down', { transport: { smtp: { auth: { pass: SECRET } } } }],
    ['the DKIM key at the root', { dkim: { privateKey: SECRET } }],
    ['the DKIM key one level down', { smtp: { dkim: { privateKey: SECRET } } }],
    ['an API key at the root', { apiKey: SECRET }],
    ['an API key one level down', { client: { apiKey: SECRET } }],
    ['the encrypted SMTP config at the root', { smtpConfigEncrypted: SECRET }],
    ['the encrypted SMTP config one level down', { email: { smtpConfigEncrypted: SECRET } }],
  ])('redacts %s', (_label, payload) => {
    const { logger, output } = captureLogs();

    logger.info(payload, 'event');

    expect(output()).toContain('[Redacted]');
    expect(output()).not.toContain(SECRET);
  });

  it('honours the configured level', () => {
    const { logger, output } = captureLogs('warn');

    logger.info('hidden message');
    logger.warn('visible message');

    expect(output()).not.toContain('hidden message');
    expect(output()).toContain('visible message');
  });
});
