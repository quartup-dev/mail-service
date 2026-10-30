import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { DrizzleSuppressionRepository } from '../../../src/infrastructure/db/drizzle-suppression-repository';
import { runSuppressionsCli } from '../../../src/interfaces/cli/suppressions-cli';
import { FakeClock } from '../../support/fake-clock';
import { resetTables, TEST_DATABASE_URL } from '../../support/integration';

const { db, pool } = connectDatabase(TEST_DATABASE_URL);

afterAll(async () => {
  await pool.end();
});

describe('suppressions CLI', () => {
  let repository: DrizzleSuppressionRepository;
  let clock: FakeClock;

  beforeEach(async () => {
    await resetTables(db, { seedClients: false });
    clock = new FakeClock();
    repository = new DrizzleSuppressionRepository(db, clock);
  });

  async function run(...argv: string[]) {
    const out: string[] = [];
    const code = await runSuppressionsCli(argv, repository, {
      out: (line) => out.push(line),
      err: (line) => out.push(line),
    });
    return { code, out: out.join('\n') };
  }

  it('adds, lists and removes an address in PostgreSQL', async () => {
    await repository.add('rebote@dominio.com', 'bounce', 'ses');
    clock.advance(60_000);

    expect((await run('add', '--email', 'Manual@Dominio.com')).code).toBe(0);
    expect((await run('list')).out).toBe(
      [
        'rebote@dominio.com\tbounce\tses\t2026-10-29T10:00:00.000Z',
        'manual@dominio.com\tmanual\tcli\t2026-10-29T10:01:00.000Z',
      ].join('\n'),
    );

    expect((await run('remove', '--email', 'rebote@dominio.com')).code).toBe(0);
    expect(await repository.findSuppressed(['rebote@dominio.com', 'manual@dominio.com'])).toEqual(
      new Set(['manual@dominio.com']),
    );
  });
});
