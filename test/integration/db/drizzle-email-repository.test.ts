import { afterAll } from 'vitest';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { DrizzleEmailRepository } from '../../../src/infrastructure/db/drizzle-email-repository';
import { describeEmailRepositoryContract } from '../../contracts/email-repository.contract';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describeEmailRepositoryContract('DrizzleEmailRepository', async () => {
  await resetTables(db);
  const clock = new FakeClock();
  return { repository: new DrizzleEmailRepository(db, clock), clock };
});
