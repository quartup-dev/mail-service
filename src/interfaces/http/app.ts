import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { GetEmailStatus } from '../../application/get-email-status';
import type { ApiClientRepository } from '../../application/ports/api-client-repository';
import type { QueueEmail } from '../../application/queue-email';
import { registerErrorHandling } from './plugins/error-handling';
import { exposeRequestId, generateRequestId } from './plugins/request-id';
import { healthRoutes, type ApiReadinessChecks } from './routes/health';

export interface AppDependencies {
  logger?: FastifyBaseLogger;
  limits: {
    maxBodyBytes: number; // MAX_BODY_BYTES
    maxAttachmentsBytes: number; // MAX_ATTACHMENTS_BYTES
    rateLimitDefaultPerMinute: number; // RATE_LIMIT_DEFAULT_PER_MINUTE
  };
  apiClients: ApiClientRepository;
  queueEmail: QueueEmail;
  getEmailStatus: GetEmailStatus;
  rateLimitRedis?: Redis; // sin Redis, el rate limit usa memoria local (tests y exportación OpenAPI)
  readiness: ApiReadinessChecks;
  version: string; // info.version de la especificación OpenAPI
}

// Crea la app sin abrir puerto: server.ts llama a listen y los tests usan inject()
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    ...(deps.logger && { loggerInstance: deps.logger }),
    genReqId: generateRequestId,
  });
  exposeRequestId(app);
  registerErrorHandling(app);
  void app.register(healthRoutes, { readiness: deps.readiness });
  return app;
}
