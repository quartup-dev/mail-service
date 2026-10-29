import { connectDatabase } from '../../src/infrastructure/db/client';
import { runMigrations } from '../../src/infrastructure/db/migrate';
import { recreateDatabase } from '../support/integration';

// Una base de datos de test nueva y migrada por ejecución de la suite de integración
export default async function setup(): Promise<void> {
  const { db, pool } = connectDatabase(await recreateDatabase('mail_test'));
  try {
    await runMigrations(db);
  } finally {
    await pool.end();
  }
}
