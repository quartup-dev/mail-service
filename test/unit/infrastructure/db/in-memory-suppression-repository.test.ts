import { InMemorySuppressionRepository } from '../../../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { describeSuppressionRepositoryContract } from '../../../contracts/suppression-repository.contract';
import { FakeClock } from '../../../support/fake-clock';

describeSuppressionRepositoryContract('InMemorySuppressionRepository', async () => {
  const clock = new FakeClock();
  return { repository: new InMemorySuppressionRepository(clock), clock };
});
