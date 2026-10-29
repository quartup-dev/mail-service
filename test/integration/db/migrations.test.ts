import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { connectDatabase } from '../../../src/infrastructure/db/client';
import { runMigrations } from '../../../src/infrastructure/db/migrate';
import { recreateDatabase } from '../../support/integration';

describe('migrations', () => {
  it('create the schema on an empty database and can run again', async () => {
    const { db, pool } = connectDatabase(await recreateDatabase('mail_migrations_test'));
    try {
      await runMigrations(db);
      await runMigrations(db);

      const { rows } = await db.execute<{ table_name: string }>(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
      `);
      expect(rows.map((row) => row.table_name)).toEqual([
        'api_clients',
        'api_keys',
        'email_attempts',
        'email_events',
        'email_recipients',
        'emails',
        'suppressions',
      ]);
    } finally {
      await pool.end();
    }
  });
});
