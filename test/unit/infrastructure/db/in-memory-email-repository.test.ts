import { InMemoryEmailRepository } from '../../../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { describeEmailRepositoryContract } from '../../../contracts/email-repository.contract';
import { FakeClock } from '../../../support/fake-clock';

describeEmailRepositoryContract('InMemoryEmailRepository', async () => {
  const clock = new FakeClock();
  return { repository: new InMemoryEmailRepository(clock), clock };
});
