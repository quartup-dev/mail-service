import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { GetEmailStatus } from '../../application/get-email-status';
import type { HandleProviderEvent } from '../../application/handle-provider-event';
import type { ApiClientRepository } from '../../application/ports/api-client-repository';
import type { QueueEmail } from '../../application/queue-email';
import type { MailgunWebhookVerifier } from '../../infrastructure/webhooks/mailgun-webhook-verifier';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { emailRoutes } from './routes/emails';
import { registerOpenApi } from './plugins/openapi';
import { registerErrorHandling } from './plugins/error-handling';
import { exposeRequestId, generateRequestId } from './plugins/request-id';
import { healthRoutes, type ApiReadinessChecks } from './routes/health';
import { mailgunWebhookRoutes } from './routes/webhooks';

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
  // Cada webhook se registra solo si su proveedor es el de MAIL_API_PROVIDER
  webhooks: {
    handleProviderEvent: HandleProviderEvent;
    mailgun: MailgunWebhookVerifier | null;
  };
}

// Crea la app sin abrir puerto: server.ts llama a listen y los tests usan inject()
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    ...(deps.logger && { loggerInstance: deps.logger }),
    genReqId: generateRequestId,
    bodyLimit: deps.limits.maxBodyBytes,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  exposeRequestId(app);
  registerErrorHandling(app);
  registerOpenApi(app, deps.version);
  void app.register(healthRoutes, { readiness: deps.readiness });
  void app.register(emailRoutes, {
    apiClients: deps.apiClients,
    queueEmail: deps.queueEmail,
    getEmailStatus: deps.getEmailStatus,
    maxAttachmentsBytes: deps.limits.maxAttachmentsBytes,
    rateLimit: {
      defaultPerMinute: deps.limits.rateLimitDefaultPerMinute,
      ...(deps.rateLimitRedis && { redis: deps.rateLimitRedis }),
    },
  });
  const { handleProviderEvent, mailgun } = deps.webhooks;
  if (mailgun) void app.register(mailgunWebhookRoutes, { verifier: mailgun, handleProviderEvent });
  return app;
}
