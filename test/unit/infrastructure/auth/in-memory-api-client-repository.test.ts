import { hashApiKeySecret } from '../../../../src/infrastructure/auth/api-keys';
import { InMemoryApiClientRepository } from '../../../../src/infrastructure/auth/in-memory-api-client-repository';
import { describeApiClientRepositoryContract } from '../../../contracts/api-client-repository.contract';
import { FakeClock } from '../../../support/fake-clock';

const PEPPER = Buffer.alloc(32, 3);

describeApiClientRepositoryContract('InMemoryApiClientRepository', async () => {
  const clock = new FakeClock();
  const repository = new InMemoryApiClientRepository(PEPPER, clock);
  return {
    repository,
    clock,
    seedClient: async ({ status = 'active', ...client }) =>
      repository.addClient({ ...client, status }),
    seedKey: async (clientId, { keyId, secret, status = 'active', expiresAt }) =>
      repository.addKey({
        clientId,
        keyId,
        hash: hashApiKeySecret(secret, PEPPER),
        status,
        expiresAt: expiresAt ?? null,
      }),
  };
});
