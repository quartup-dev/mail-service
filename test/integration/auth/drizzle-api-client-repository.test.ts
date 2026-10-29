import { afterAll } from 'vitest';
import { hashApiKeySecret } from '../../../src/infrastructure/auth/api-keys';
import { DrizzleApiClientRepository } from '../../../src/infrastructure/auth/drizzle-api-client-repository';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { apiClients, apiKeys } from '../../../src/infrastructure/db/schema';
import { describeApiClientRepositoryContract } from '../../contracts/api-client-repository.contract';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const PEPPER = Buffer.alloc(32, 3);
const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describeApiClientRepositoryContract('DrizzleApiClientRepository', async () => {
  await resetTables(db, { seedClients: false });
  const clock = new FakeClock();
  return {
    repository: new DrizzleApiClientRepository(db, PEPPER, clock),
    clock,
    seedClient: async ({ status = 'active', ...client }) => {
      await db.insert(apiClients).values({
        id: client.id,
        name: client.name,
        status,
        allowedTransports: client.allowedTransports,
        allowedFromDomains: client.allowedFromDomains ?? null,
        rateLimitPerMinute: client.rateLimitPerMinute ?? null,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
    },
    seedKey: async (clientId, { keyId, secret, status = 'active', expiresAt }) => {
      await db.insert(apiKeys).values({
        clientId,
        keyId,
        hash: hashApiKeySecret(secret, PEPPER),
        status,
        createdAt: clock.now(),
        expiresAt: expiresAt ?? null,
      });
    },
  };
});
