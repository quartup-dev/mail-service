import { ConfigError, loadConfig } from './infrastructure/config';
import { createWorkerContainer } from './infrastructure/container';
import { createLogger } from './infrastructure/logger';

function loadWorkerConfig() {
  try {
    return loadConfig('worker');
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadWorkerConfig();
const logger = createLogger({ level: config.logLevel });
const container = createWorkerContainer(config, logger);
const { runtime, health } = container;

// Apagado ordenado: /ready pasa a 503, se dejan de aceptar jobs, se esperan los activos y se
// cierran las conexiones
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  health.markShuttingDown();
  await runtime.close();
  await container.close();
  await health.close();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      },
    );
  });
}

await runtime.start();
await health.listen(config.worker.healthPort);
logger.info({ queues: config.worker.queues, healthPort: config.worker.healthPort }, 'Worker ready');
