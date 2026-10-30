import { describe, expect, it } from 'vitest';
import { InMemoryReplayGuard } from '../../../../src/infrastructure/webhooks/in-memory-replay-guard';
import { describeReplayGuardContract } from '../../../contracts/replay-guard.contract';
import { FakeClock } from '../../../support/fake-clock';

describeReplayGuardContract(
  'InMemoryReplayGuard',
  async () => new InMemoryReplayGuard(new FakeClock()),
);

describe('InMemoryReplayGuard', () => {
  it('lets a key be claimed again once its TTL has passed', async () => {
    const clock = new FakeClock();
    const guard = new InMemoryReplayGuard(clock);
    await guard.claim('ses:message-1', 1_000);

    clock.advance(999);
    expect(await guard.claim('ses:message-1', 1_000)).toBe(false);
    clock.advance(1);
    expect(await guard.claim('ses:message-1', 1_000)).toBe(true);
  });
});
