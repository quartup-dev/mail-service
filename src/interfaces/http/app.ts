import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health';

export interface AppDependencies {
  logger?: FastifyBaseLogger;
}

// Crea la app sin abrir puerto: server.ts llama a listen y los tests usan inject()
export function buildApp(deps: AppDependencies = {}): FastifyInstance {
  const app = Fastify(deps.logger ? { loggerInstance: deps.logger } : {});
  void app.register(healthRoutes);
  return app;
}
