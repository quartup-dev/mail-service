import { describe, expect, it } from 'vitest';
import { computeRequestHash } from '../../../src/application/request-hash';
import { apiRequest, smtpRequest } from '../../support/email-requests';

const PEPPER = Buffer.alloc(32, 3);

describe('computeRequestHash', () => {
  it('produces different hashes for different requests', () => {
    expect(computeRequestHash(apiRequest({ subject: 'A' }), PEPPER)).not.toBe(
      computeRequestHash(apiRequest({ subject: 'B' }), PEPPER),
    );
  });

  it('produces the same hash for the same request', () => {
    expect(computeRequestHash(smtpRequest(), PEPPER)).toBe(computeRequestHash(smtpRequest(), PEPPER));
  });

  it('hashes the SMTP password and DKIM key with the pepper instead of in plain text', () => {
    const otherPepper = Buffer.alloc(32, 4);

    expect(computeRequestHash(smtpRequest(), PEPPER)).not.toBe(
      computeRequestHash(smtpRequest(), otherPepper),
    );
  });

  it.each([
    ['password', { auth: { user: 'notificaciones@example.com', pass: 'another-password' } }],
    ['DKIM key', { dkim: { domainName: 'example.com', keySelector: 'mail', privateKey: 'other' } }],
  ])('changes when the SMTP %s changes', (_secret, smtpOverride) => {
    const original = smtpRequest();
    if (original.transport.type !== 'smtp') throw new Error('expected an SMTP request');
    const changed = smtpRequest({
      transport: { type: 'smtp', smtp: { ...original.transport.smtp, ...smtpOverride } },
    });

    expect(computeRequestHash(changed, PEPPER)).not.toBe(computeRequestHash(original, PEPPER));
  });
});
