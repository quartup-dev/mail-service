import { afterAll } from 'vitest';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { DrizzleSuppressionRepository } from '../../../src/infrastructure/db/drizzle-suppression-repository';
import { describeSuppressionRepositoryContract } from '../../contracts/suppression-repository.contract';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describeSuppressionRepositoryContract('DrizzleSuppressionRepository', async () => {
  await resetTables(db);
  const clock = new FakeClock();
  return { repository: new DrizzleSuppressionRepository(db, clock), clock };
});
