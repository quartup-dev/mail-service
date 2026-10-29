import { ConfigError, loadConfig } from '../src/infrastructure/config';
import { DrizzleApiClientAdmin } from '../src/infrastructure/auth/drizzle-api-client-admin';
import { connectDatabase } from '../src/infrastructure/db/client';
import { SystemClock } from '../src/infrastructure/system-clock';
import { runKeysCli } from '../src/interfaces/cli/keys-cli';

function loadKeysConfig() {
  try {
    return loadConfig('keys-cli');
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadKeysConfig();
const { db, pool } = connectDatabase(config.databaseUrl);
try {
  process.exitCode = await runKeysCli(
    process.argv.slice(2),
    new DrizzleApiClientAdmin(db, config.apiKeyPepper, new SystemClock()),
    { out: (line) => console.log(line), err: (line) => console.error(line) },
  );
} finally {
  await pool.end();
}
