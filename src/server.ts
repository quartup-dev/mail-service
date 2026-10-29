import { ConfigError, loadConfig } from './infrastructure/config';
import { createLogger } from './infrastructure/logger';
import { buildApp } from './interfaces/http/app';

function loadApiConfig() {
  try {
    return loadConfig('api');
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadApiConfig();
const logger = createLogger({ level: config.logLevel });
const app = buildApp({ logger });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
logger.info({ runtime: `node ${process.versions.node}` }, 'API ready');
