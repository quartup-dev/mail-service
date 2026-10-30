import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisReplayGuard } from '../../../src/infrastructure/webhooks/redis-replay-guard';
import { describeReplayGuardContract } from '../../contracts/replay-guard.contract';
import { TEST_REDIS_URL } from '../../support/integration';

const redis = new Redis(TEST_REDIS_URL);

afterAll(async () => {
  await redis.quit();
});

// Cada test usa su propio prefijo para no ver las claves de otros
describeReplayGuardContract(
  'RedisReplayGuard',
  async () => new RedisReplayGuard(redis, `test-${randomUUID()}:`),
);

describe('RedisReplayGuard', () => {
  it('stores the claim with the TTL under its prefix', async () => {
    const prefix = `test-${randomUUID()}:`;
    const guard = new RedisReplayGuard(redis, prefix);

    await guard.claim('ses:message-1', 60_000);

    const ttl = await redis.pttl(`${prefix}ses:message-1`);
    expect(ttl).toBeGreaterThan(59_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
