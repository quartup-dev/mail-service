import { ConfigError, loadConfig } from '../src/infrastructure/config';
import { connectDatabase } from '../src/infrastructure/db/client';
import { DrizzleSuppressionRepository } from '../src/infrastructure/db/drizzle-suppression-repository';
import { SystemClock } from '../src/infrastructure/system-clock';
import { runSuppressionsCli } from '../src/interfaces/cli/suppressions-cli';

function loadSuppressionsConfig() {
  try {
    return loadConfig('suppressions-cli');
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadSuppressionsConfig();
const { db, pool } = connectDatabase(config.databaseUrl);
try {
  process.exitCode = await runSuppressionsCli(
    process.argv.slice(2),
    new DrizzleSuppressionRepository(db, new SystemClock()),
    { out: (line) => console.log(line), err: (line) => console.error(line) },
  );
} finally {
  await pool.end();
}
