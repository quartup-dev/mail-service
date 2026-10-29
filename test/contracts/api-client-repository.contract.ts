import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApiClient,
  ApiClientRepository,
} from '../../src/application/ports/api-client-repository';
import type { FakeClock } from '../support/fake-clock';

export interface SeedKey {
  keyId: string;
  secret: string;
  status?: 'active' | 'revoked';
  expiresAt?: Date;
}

export interface ApiClientRepositoryContext {
  repository: ApiClientRepository;
  clock: FakeClock;
  seedClient(client: ApiClient & { status?: 'active' | 'disabled' }): Promise<void>;
  seedKey(clientId: string, key: SeedKey): Promise<void>;
}

const BILLING: ApiClient = {
  id: 'billing',
  name: 'Facturación',
  allowedTransports: ['api'],
  allowedFromDomains: ['example.com'],
  rateLimitPerMinute: 60,
};

// Batería común a todas las implementaciones de ApiClientRepository (en memoria y Drizzle)
export function describeApiClientRepositoryContract(
  name: string,
  createContext: () => Promise<ApiClientRepositoryContext>,
): void {
  describe(`${name} (ApiClientRepository contract)`, () => {
    let context: ApiClientRepositoryContext;

    beforeEach(async () => {
      context = await createContext();
      await context.seedClient(BILLING);
    });

    const authenticate = (key: string) => context.repository.authenticate(key);

    it('returns the client of a valid key', async () => {
      await context.seedKey('billing', { keyId: 'k1', secret: 'valid-secret' });

      expect(await authenticate('ms_billing_valid-secret')).toEqual(BILLING);
    });

    it('accepts underscores and dashes in the secret', async () => {
      await context.seedKey('billing', { keyId: 'k1', secret: 'a_b-c_d' });

      expect(await authenticate('ms_billing_a_b-c_d')).toEqual(BILLING);
    });

    it('omits the optional settings the client does not have', async () => {
      await context.seedClient({ id: 'crm', name: 'CRM', allowedTransports: ['smtp', 'api'] });
      await context.seedKey('crm', { keyId: 'k1', secret: 'crm-secret' });

      expect(await authenticate('ms_crm_crm-secret')).toEqual({
        id: 'crm',
        name: 'CRM',
        allowedTransports: ['smtp', 'api'],
      });
    });

    it('accepts either of two active keys', async () => {
      await context.seedKey('billing', { keyId: 'k1', secret: 'first' });
      await context.seedKey('billing', { keyId: 'k2', secret: 'second' });

      expect(await authenticate('ms_billing_first')).toEqual(BILLING);
      expect(await authenticate('ms_billing_second')).toEqual(BILLING);
    });

    it('accepts a key that has not expired yet', async () => {
      await context.seedKey('billing', {
        keyId: 'k1',
        secret: 'valid-secret',
        expiresAt: new Date(context.clock.now().getTime() + 1_000),
      });

      expect(await authenticate('ms_billing_valid-secret')).toEqual(BILLING);
    });

    it('rejects a revoked key', async () => {
      await context.seedKey('billing', { keyId: 'k1', secret: 'valid-secret', status: 'revoked' });

      expect(await authenticate('ms_billing_valid-secret')).toBeNull();
    });

    it('rejects an expired key', async () => {
      await context.seedKey('billing', {
        keyId: 'k1',
        secret: 'valid-secret',
        expiresAt: context.clock.now(),
      });

      expect(await authenticate('ms_billing_valid-secret')).toBeNull();
    });

    it('rejects the key of a disabled client', async () => {
      await context.seedClient({
        id: 'crm',
        name: 'CRM',
        allowedTransports: ['api'],
        status: 'disabled',
      });
      await context.seedKey('crm', { keyId: 'k1', secret: 'crm-secret' });

      expect(await authenticate('ms_crm_crm-secret')).toBeNull();
    });

    it.each([
      ['an unknown client id', 'ms_nobody_valid-secret'],
      ['a wrong secret', 'ms_billing_wrong-secret'],
      ['a malformed key', 'billing_valid-secret'],
    ])('rejects %s', async (_case, key) => {
      await context.seedKey('billing', { keyId: 'k1', secret: 'valid-secret' });

      expect(await authenticate(key)).toBeNull();
    });
  });
}
