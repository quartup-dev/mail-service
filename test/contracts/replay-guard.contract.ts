import { beforeEach, describe, expect, it } from 'vitest';
import type { ReplayGuard } from '../../src/infrastructure/webhooks/replay-guard';

const TTL_MS = 60_000;

// Batería común a todas las implementaciones de ReplayGuard (en memoria y Redis)
export function describeReplayGuardContract(
  name: string,
  createGuard: () => Promise<ReplayGuard>,
): void {
  describe(`${name} (ReplayGuard contract)`, () => {
    let guard: ReplayGuard;

    beforeEach(async () => {
      guard = await createGuard();
    });

    it('grants the first claim of a key and refuses the second', async () => {
      expect(await guard.claim('mailgun:token-1', TTL_MS)).toBe(true);
      expect(await guard.claim('mailgun:token-1', TTL_MS)).toBe(false);
    });

    it('lets a released key be claimed again', async () => {
      await guard.claim('mailgun:token-1', TTL_MS);

      await guard.release('mailgun:token-1');

      expect(await guard.claim('mailgun:token-1', TTL_MS)).toBe(true);
    });

    it('keeps different keys independent', async () => {
      await guard.claim('mailgun:token-1', TTL_MS);

      expect(await guard.claim('mailgun:token-2', TTL_MS)).toBe(true);
    });
  });
}
