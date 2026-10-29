import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { HealthResponseSchema, ReadyResponseSchema } from '../schemas/health';
import { RequestIdHeadersSchema } from '../schemas/request-id';

export interface ApiReadinessChecks {
  postgres: () => Promise<void>; // lanzan si la dependencia no responde
  redis: () => Promise<void>;
  apiProvider: (() => Promise<void>) | null; // verify() del proveedor; null si no hay
}

type CheckState = 'ok' | 'error';

export const healthRoutes: FastifyPluginAsync<{ readiness: ApiReadinessChecks }> = async (
  scope,
  { readiness },
) => {
  const app = scope.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/health',
    {
      schema: {
        summary: 'El proceso responde',
        tags: ['health'],
        headers: RequestIdHeadersSchema,
        response: { 200: HealthResponseSchema.describe('Proceso en marcha') },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    {
      schema: {
        summary: 'PostgreSQL, Redis y el proveedor de API responden',
        tags: ['health'],
        headers: RequestIdHeadersSchema,
        response: {
          200: ReadyResponseSchema.describe('Todas las dependencias responden'),
          503: ReadyResponseSchema.describe('Alguna dependencia no responde'),
        },
      },
    },
    async (_request, reply) => {
      const [postgres, redis, apiProvider] = await Promise.all([
        stateOf(readiness.postgres()),
        stateOf(readiness.redis()),
        readiness.apiProvider ? stateOf(readiness.apiProvider()) : ('not_configured' as const),
      ]);
      const ready = [postgres, redis, apiProvider].every((state) => state !== 'error');
      return reply.code(ready ? 200 : 503).send({
        status: ready ? 'ready' : 'not_ready',
        checks: { postgres, redis, apiProvider },
      });
    },
  );
};

function stateOf(check: Promise<void>): Promise<CheckState> {
  return check.then(
    () => 'ok',
    () => 'error',
  );
}
