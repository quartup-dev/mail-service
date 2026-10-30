import { describe, expect, it } from 'vitest';
import { SnsHttpClient } from '../../../../src/infrastructure/webhooks/sns-http-client';

const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem';

// fetch simulado: guarda cada llamada y responde con el estado y el cuerpo indicados
function fakeFetch(status = 200, body = '-----BEGIN CERTIFICATE-----') {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return new Response(body, { status });
  };
  return { calls, fetchFn };
}

describe('SnsHttpClient', () => {
  it('returns the PEM of a certificate answered with 2xx', async () => {
    const { fetchFn } = fakeFetch();
    const client = new SnsHttpClient(fetchFn, 5_000);

    await expect(client.downloadCertificate(CERT_URL)).resolves.toBe('-----BEGIN CERTIFICATE-----');
  });

  it('throws when the certificate is not answered with 2xx', async () => {
    const { fetchFn } = fakeFetch(404, 'Not Found');
    const client = new SnsHttpClient(fetchFn, 5_000);

    await expect(client.downloadCertificate(CERT_URL)).rejects.toThrow(
      'SNS answered 404 to GET https://sns.eu-west-1.amazonaws.com/',
    );
  });

  it('does not follow redirects and gives up after the timeout', async () => {
    const { fetchFn, calls } = fakeFetch();
    const client = new SnsHttpClient(fetchFn, 5_000);

    await client.downloadCertificate(CERT_URL);

    expect(calls[0]?.init?.redirect).toBe('error');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('confirms a subscription with a GET to its SubscribeURL', async () => {
    const { fetchFn, calls } = fakeFetch(200, '<ConfirmSubscriptionResponse/>');
    const client = new SnsHttpClient(fetchFn, 5_000);
    const subscribeUrl =
      'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc';

    await client.confirmSubscription(subscribeUrl);

    expect(calls).toMatchObject([{ url: subscribeUrl, init: { redirect: 'error' } }]);
  });

  it('throws when the confirmation is not answered with 2xx', async () => {
    const { fetchFn } = fakeFetch(403, '<Error/>');
    const client = new SnsHttpClient(fetchFn, 5_000);

    await expect(
      client.confirmSubscription('https://sns.eu-west-1.amazonaws.com/?Token=abc'),
    ).rejects.toThrow('SNS answered 403');
  });
});
