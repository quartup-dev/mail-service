import type { Clock } from '../../application/ports/clock';
import type { ReplayGuard } from './replay-guard';

// Para tests y para generar la especificación OpenAPI; en producción se usa Redis
export class InMemoryReplayGuard implements ReplayGuard {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now().getTime();
    const expiry = this.expiresAt.get(key);
    if (expiry !== undefined && expiry > now) return false;
    this.expiresAt.set(key, now + ttlMs);
    return true;
  }

  async release(key: string): Promise<void> {
    this.expiresAt.delete(key);
  }
}
