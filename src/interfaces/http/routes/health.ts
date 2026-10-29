import type { FastifyPluginAsync } from 'fastify';

export interface ApiReadinessChecks {
  postgres: () => Promise<void>; // lanzan si la dependencia no responde
  redis: () => Promise<void>;
  apiProvider: (() => Promise<void>) | null; // verify() del proveedor; null si no hay
}

type CheckState = 'ok' | 'error';

export const healthRoutes: FastifyPluginAsync<{ readiness: ApiReadinessChecks }> = async (
  app,
  { readiness },
) => {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    const [postgres, redis, apiProvider] = await Promise.all([
      stateOf(readiness.postgres()),
      stateOf(readiness.redis()),
      readiness.apiProvider ? stateOf(readiness.apiProvider()) : 'not_configured',
    ]);
    const ready = [postgres, redis, apiProvider].every((state) => state !== 'error');
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ready' : 'not_ready', checks: { postgres, redis, apiProvider } });
  });
};

function stateOf(check: Promise<void>): Promise<CheckState> {
  return check.then(
    () => 'ok',
    () => 'error',
  );
}
