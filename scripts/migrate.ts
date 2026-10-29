import { ConfigError, loadConfig } from '../src/infrastructure/config';
import { connectDatabase } from '../src/infrastructure/db/client';
import { runMigrations } from '../src/infrastructure/db/migrate';

function loadMigrateConfig() {
  try {
    return loadConfig('migrate');
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const { db, pool } = connectDatabase(loadMigrateConfig().databaseUrl);
try {
  await runMigrations(db);
  console.log('Migrations applied');
} finally {
  await pool.end();
}
