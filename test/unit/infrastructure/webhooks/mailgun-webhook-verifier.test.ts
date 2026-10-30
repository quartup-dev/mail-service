import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryReplayGuard } from '../../../../src/infrastructure/webhooks/in-memory-replay-guard';
import { MailgunWebhookVerifier } from '../../../../src/infrastructure/webhooks/mailgun-webhook-verifier';
import { WebhookRejectedError } from '../../../../src/infrastructure/webhooks/webhook-verification';
import { FakeClock } from '../../../support/fake-clock';

const SIGNING_KEY = 'test-signing-key';

function setup() {
  const clock = new FakeClock();
  const verifier = new MailgunWebhookVerifier({
    signingKey: SIGNING_KEY,
    replayGuard: new InMemoryReplayGuard(clock),
    clock,
  });
  const nowSeconds = () => String(Math.floor(clock.now().getTime() / 1_000));
  const signed = (overrides: { timestamp?: string; token?: string } = {}) => {
    const timestamp = overrides.timestamp ?? nowSeconds();
    const token = overrides.token ?? 'a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0';
    const signature = createHmac('sha256', SIGNING_KEY)
      .update(timestamp + token)
      .digest('hex');
    return { timestamp, token, signature };
  };
  return { clock, verifier, signed };
}

describe('MailgunWebhookVerifier', () => {
  it('accepts the HMAC-SHA256 of timestamp and token made with the signing key', async () => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed())).resolves.not.toBeNull();
  });

  it.each([
    ['that does not match', (valid: string) => valid.replace(/^./, valid[0] === 'a' ? 'b' : 'a')],
    ['of another length', (valid: string) => valid.slice(0, -2)],
    ['that is not hex', (valid: string) => `${valid.slice(0, -1)}z`],
  ])('rejects a signature %s', async (_case, tamper) => {
    const { verifier, signed } = setup();
    const valid = signed();

    await expect(verifier.verify({ ...valid, signature: tamper(valid.signature) })).rejects.toThrow(
      new WebhookRejectedError('invalid_signature'),
    );
  });

  it.each([
    ['more than 5 minutes old', -301],
    ['more than 5 minutes in the future', 301],
  ])('rejects a timestamp %s', async (_case, offsetSeconds) => {
    const { verifier, signed, clock } = setup();
    const timestamp = String(Math.floor(clock.now().getTime() / 1_000) + offsetSeconds);

    await expect(verifier.verify(signed({ timestamp }))).rejects.toThrow(
      new WebhookRejectedError('stale_timestamp'),
    );
  });

  it('accepts a timestamp within 5 minutes', async () => {
    const { verifier, signed, clock } = setup();
    const timestamp = String(Math.floor(clock.now().getTime() / 1_000) - 300);

    await expect(verifier.verify(signed({ timestamp }))).resolves.not.toBeNull();
  });

  it('reports a repeated token as a replay', async () => {
    const { verifier, signed } = setup();
    await verifier.verify(signed());

    await expect(verifier.verify(signed())).resolves.toBeNull();
  });

  it('does not claim the token of a request with an invalid signature', async () => {
    const { verifier, signed } = setup();
    await verifier.verify({ ...signed(), signature: 'forged' }).catch(() => {});

    await expect(verifier.verify(signed())).resolves.not.toBeNull();
  });

  it('lets a released token be processed again', async () => {
    const { verifier, signed } = setup();
    const claim = await verifier.verify(signed());

    await claim?.release();

    await expect(verifier.verify(signed())).resolves.not.toBeNull();
  });

  it('rejects a timestamp that is not a number', async () => {
    const { verifier, signed } = setup();

    await expect(verifier.verify(signed({ timestamp: 'yesterday' }))).rejects.toThrow(
      new WebhookRejectedError('stale_timestamp'),
    );
  });
});
