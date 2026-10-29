import { z } from 'zod';

export const HealthResponseSchema = z
  .object({ status: z.literal('ok') })
  .meta({ id: 'HealthResponse', description: 'El proceso responde' });

const CheckStateSchema = z.enum(['ok', 'error']);

export const ReadyResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      postgres: CheckStateSchema,
      redis: CheckStateSchema,
      apiProvider: z
        .enum(['ok', 'error', 'not_configured'])
        .describe('not_configured si MAIL_API_PROVIDER está vacío'),
    }),
  })
  .meta({ id: 'ReadyResponse', description: 'Estado de cada dependencia de la API' });
