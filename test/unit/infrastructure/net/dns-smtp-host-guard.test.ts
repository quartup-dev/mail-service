import { describe, expect, it } from 'vitest';
import { SmtpHostNotAllowedError } from '../../../../src/domain/errors';
import {
  DnsSmtpHostGuard,
  lookupAllAddresses,
  type SmtpHostPolicy,
} from '../../../../src/infrastructure/net/dns-smtp-host-guard';

const PUBLIC_IP = '93.184.215.14';

function guardWith(
  dns: Record<string, string[]> = {},
  policy: Partial<SmtpHostPolicy> = {},
): DnsSmtpHostGuard {
  return new DnsSmtpHostGuard(
    { allowedHosts: [], allowedPrivateHosts: [], ...policy },
    // Como el DNS real, sin distinguir mayúsculas
    async (host) => dns[host.toLowerCase()] ?? [],
  );
}

describe('DnsSmtpHostGuard', () => {
  it.each([25, 2525, 443])('rejects port %i', async (port) => {
    const guard = guardWith({ 'smtp.example.com': [PUBLIC_IP] });

    await expect(guard.resolveAndValidate('smtp.example.com', port)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.10',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('rejects the non-public IPv4 %s, as a literal and as a DNS answer', async (ip) => {
    const guard = guardWith({ 'smtp.example.com': [ip] });

    await expect(guard.resolveAndValidate(ip, 587)).rejects.toBeInstanceOf(SmtpHostNotAllowedError);
    await expect(guard.resolveAndValidate('smtp.example.com', 587)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });

  it.each(['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1'])(
    'rejects the non-public IPv6 %s',
    async (ip) => {
      await expect(guardWith().resolveAndValidate(ip, 587)).rejects.toBeInstanceOf(
        SmtpHostNotAllowedError,
      );
    },
  );

  it.each(['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe'])(
    'rejects the IPv4-mapped IPv6 %s that points to a forbidden range',
    async (ip) => {
      await expect(guardWith().resolveAndValidate(ip, 587)).rejects.toBeInstanceOf(
        SmtpHostNotAllowedError,
      );
    },
  );

  it.each([PUBLIC_IP, '2606:2800:21f:cb07:6820:80da:af6b:8b2c', `::ffff:${PUBLIC_IP}`])(
    'accepts the public IP %s as a literal',
    async (ip) => {
      await expect(guardWith().resolveAndValidate(ip, 465)).resolves.toEqual({ host: ip, ip });
    },
  );

  it('accepts a public hostname and returns its first address', async () => {
    const guard = guardWith({ 'smtp.example.com': [PUBLIC_IP, '93.184.215.15'] });

    await expect(guard.resolveAndValidate('smtp.example.com', 587)).resolves.toEqual({
      host: 'smtp.example.com',
      ip: PUBLIC_IP,
    });
  });

  it('rejects a hostname when any of its addresses is not public', async () => {
    const guard = guardWith({ 'smtp.example.com': [PUBLIC_IP, '10.0.0.5'] });

    await expect(guard.resolveAndValidate('smtp.example.com', 587)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });

  it('rejects a hostname that does not resolve', async () => {
    await expect(guardWith().resolveAndValidate('nowhere.example.com', 587)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });

  it('lets the allowed private hosts resolve to private addresses, and only them', async () => {
    const guard = guardWith(
      { mailpit: ['172.18.0.4'], 'other.internal': ['172.18.0.5'] },
      { allowedPrivateHosts: ['mailpit', 'localhost'] },
    );

    await expect(guard.resolveAndValidate('Mailpit', 587)).resolves.toEqual({
      host: 'Mailpit',
      ip: '172.18.0.4',
    });
    await expect(guard.resolveAndValidate('other.internal', 587)).rejects.toBeInstanceOf(
      SmtpHostNotAllowedError,
    );
  });

  it.each([
    ['smtp.example.com', true],
    ['mail.example.org', true],
    ['a.b.example.org', true],
    ['example.org', false],
    ['smtp.other.com', false],
  ])('with an allow list, accepts %s: %s', async (host, accepted) => {
    const guard = guardWith(
      { [host]: [PUBLIC_IP] },
      { allowedHosts: ['smtp.example.com', '*.example.org'] },
    );

    const result = guard.resolveAndValidate(host, 587);

    if (accepted) await expect(result).resolves.toMatchObject({ host });
    else await expect(result).rejects.toBeInstanceOf(SmtpHostNotAllowedError);
  });
});

describe('lookupAllAddresses', () => {
  it('resolves through the system resolver, including /etc/hosts', async () => {
    const addresses = await lookupAllAddresses('localhost');

    expect(addresses.some((address) => address === '127.0.0.1' || address === '::1')).toBe(true);
  });
});
