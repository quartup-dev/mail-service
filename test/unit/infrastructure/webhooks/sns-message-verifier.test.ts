import { describe, expect, it } from 'vitest';
import { InMemoryReplayGuard } from '../../../../src/infrastructure/webhooks/in-memory-replay-guard';
import { SnsMessageVerifier } from '../../../../src/infrastructure/webhooks/sns-message-verifier';
import { WebhookRejectedError } from '../../../../src/infrastructure/webhooks/webhook-verification';
import { FakeClock } from '../../../support/fake-clock';
import {
  signedSnsMessage,
  SNS_CERT_URL,
  SNS_REGION,
  SNS_TEST_CERTIFICATE,
  SNS_TOPIC_ARN,
  type SnsTestMessage,
} from '../../../support/webhooks';

function setup() {
  const clock = new FakeClock();
  const downloads: string[] = [];
  const verifier = new SnsMessageVerifier({
    region: SNS_REGION,
    topicArns: [SNS_TOPIC_ARN],
    downloadCertificate: async (url) => {
      downloads.push(url);
      return SNS_TEST_CERTIFICATE;
    },
    replayGuard: new InMemoryReplayGuard(clock),
    clock,
  });
  const signed = (fields: SnsTestMessage = {}) => signedSnsMessage(clock, fields);
  return { clock, verifier, signed, downloads };
}

describe('SnsMessageVerifier', () => {
  it('accepts a notification signed with SignatureVersion 2 (SHA256withRSA)', async () => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed())).resolves.not.toBeNull();
  });

  it('accepts a notification signed with SignatureVersion 1 (SHA1withRSA)', async () => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed({ SignatureVersion: '1' }))).resolves.not.toBeNull();
  });

  it('rejects a message altered after signing', async () => {
    const { verifier, signed } = setup();

    await expect(
      verifier.verify({ ...signed({ Message: '{"eventType":"Delivery"}' }), Message: '{}' }),
    ).rejects.toThrow(new WebhookRejectedError('invalid_signature'));
  });

  it('rejects a signature that is not valid base64 RSA', async () => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed({ Signature: 'forged' }))).rejects.toThrow(
      new WebhookRejectedError('invalid_signature'),
    );
  });

  it.each(['3', '', 'v2'])('rejects SignatureVersion %j', async (version) => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed({ SignatureVersion: version }))).rejects.toThrow(
      new WebhookRejectedError('invalid_signature'),
    );
  });

  it('includes the Subject of a notification in the signed string', async () => {
    const { verifier, signed } = setup();
    const message = signed({ Subject: 'Amazon SES Email Event Notification' });

    await expect(verifier.verify(message)).resolves.not.toBeNull();
    await expect(verifier.verify({ ...message, Subject: 'Altered' })).rejects.toThrow(
      new WebhookRejectedError('invalid_signature'),
    );
  });

  it.each(['SubscriptionConfirmation', 'UnsubscribeConfirmation'])(
    'signs SubscribeURL and Token in a %s',
    async (Type) => {
      const { verifier, signed } = setup();
      const message = signed({
        Type,
        SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc',
        Token: 'abc',
      });

      await expect(verifier.verify(message)).resolves.not.toBeNull();
      await expect(verifier.verify({ ...message, Token: 'other' })).rejects.toThrow(
        new WebhookRejectedError('invalid_signature'),
      );
    },
  );

  it('rejects an unknown message type', async () => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed({ Type: 'Unknown' }))).rejects.toThrow(
      new WebhookRejectedError('invalid_signature'),
    );
  });

  it.each([
    ['http', 'http://sns.eu-west-1.amazonaws.com/cert.pem'],
    ['a foreign host', 'https://evil.example/cert.pem'],
    [
      'amazonaws.com only as a substring of the host',
      'https://sns.eu-west-1.amazonaws.com.evil.example/cert.pem',
    ],
    [
      'credentials before a foreign host',
      'https://sns.eu-west-1.amazonaws.com@evil.example/cert.pem',
    ],
    ['another region', 'https://sns.us-east-1.amazonaws.com/cert.pem'],
    ['an explicit port', 'https://sns.eu-west-1.amazonaws.com:8443/cert.pem'],
    ['a path that is not a .pem', 'https://sns.eu-west-1.amazonaws.com/cert.pem.txt'],
    ['something that is not a URL', 'not a url'],
  ])('rejects a SigningCertURL with %s without downloading it', async (_case, url) => {
    const { verifier, signed, downloads } = setup();

    await expect(verifier.verify(signed({ SigningCertURL: url }))).rejects.toThrow(
      new WebhookRejectedError('untrusted_certificate_url'),
    );
    expect(downloads).toEqual([]);
  });

  it('rejects a topic that is not in SES_SNS_TOPIC_ARNS without downloading the certificate', async () => {
    const { verifier, signed, downloads } = setup();

    await expect(
      verifier.verify(signed({ TopicArn: 'arn:aws:sns:eu-west-1:999999999999:attacker-topic' })),
    ).rejects.toThrow(new WebhookRejectedError('unknown_topic'));
    expect(downloads).toEqual([]);
  });

  it.each([
    ['more than 1 hour old', -3_600_001],
    ['more than 5 minutes in the future', 300_001],
    ['that is not a date', Number.NaN],
  ])('rejects a Timestamp %s', async (_case, offsetMs) => {
    const { verifier, signed, clock } = setup();
    const timestamp = Number.isNaN(offsetMs)
      ? 'yesterday'
      : new Date(clock.now().getTime() + offsetMs).toISOString();

    await expect(verifier.verify(signed({ Timestamp: timestamp }))).rejects.toThrow(
      new WebhookRejectedError('stale_timestamp'),
    );
  });

  it('accepts a Timestamp up to 1 hour old, as SNS retries deliveries', async () => {
    const { verifier, signed, clock } = setup();
    const timestamp = new Date(clock.now().getTime() - 3_600_000).toISOString();

    await expect(verifier.verify(signed({ Timestamp: timestamp }))).resolves.not.toBeNull();
  });

  it('reports a repeated MessageId as a replay and lets a released one through', async () => {
    const { verifier, signed } = setup();
    const message = signed();

    const claim = await verifier.verify(message);
    await expect(verifier.verify(message)).resolves.toBeNull();
    await claim?.release();
    await expect(verifier.verify(message)).resolves.not.toBeNull();
  });

  it('downloads each certificate only once', async () => {
    const { verifier, signed, downloads } = setup();

    await verifier.verify(signed());
    await verifier.verify(signed());

    expect(downloads).toEqual([SNS_CERT_URL]);
  });

  it('does not cache a failed download', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const verifier = new SnsMessageVerifier({
      region: SNS_REGION,
      topicArns: [SNS_TOPIC_ARN],
      downloadCertificate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return SNS_TEST_CERTIFICATE;
      },
      replayGuard: new InMemoryReplayGuard(clock),
      clock,
    });

    await expect(verifier.verify(signedSnsMessage(clock))).rejects.toThrow('network down');
    await expect(verifier.verify(signedSnsMessage(clock))).resolves.not.toBeNull();
  });

  it('rejects a confirmation whose SubscribeURL is not an SNS URL of the region', async () => {
    const { verifier, signed } = setup();

    await expect(
      verifier.verify(
        signed({
          Type: 'SubscriptionConfirmation',
          SubscribeURL: 'https://internal.example/admin?Token=abc',
          Token: 'abc',
        }),
      ),
    ).rejects.toThrow(new WebhookRejectedError('untrusted_subscribe_url'));
  });
});
