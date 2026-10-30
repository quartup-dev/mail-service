import type { Redis } from 'ioredis';
import type { ReplayGuard } from './replay-guard';

// SET NX: compartido por todas las instancias de la API y atómico ante peticiones simultáneas
export class RedisReplayGuard implements ReplayGuard {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'mail-service:webhook-replay:',
  ) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(`${this.prefix}${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async release(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}${key}`);
  }
}
