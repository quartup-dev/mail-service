import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HandleProviderEvent } from '../../../application/handle-provider-event';
import type { MailgunWebhookVerifier } from '../../../infrastructure/webhooks/mailgun-webhook-verifier';
import {
  WebhookRejectedError,
  type WebhookClaim,
} from '../../../infrastructure/webhooks/webhook-verification';
import { ApiError } from '../api-error';
import { ErrorResponseSchema } from '../schemas/errors';
import { MailgunWebhookRequestSchema } from '../schemas/webhooks';
import { toProviderEvent } from '../webhooks/mailgun-events';

// Rutas expuestas a internet: límite propio, muy por debajo del de POST /v1/emails (SNS admite 256 KB)
const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;

export interface MailgunWebhookOptions {
  verifier: MailgunWebhookVerifier;
  handleProviderEvent: HandleProviderEvent;
}

// Sin API key ni rate limit: la autenticidad la da la firma del proveedor
export const mailgunWebhookRoutes: FastifyPluginAsync<MailgunWebhookOptions> = async (
  scope,
  options,
) => {
  const app = scope.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/v1/webhooks/mailgun',
    {
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      schema: {
        summary: 'Recibe los eventos de entrega de Mailgun',
        tags: ['webhooks'],
        body: MailgunWebhookRequestSchema,
        response: {
          204: z.null().describe('Evento procesado, ignorado o repetido'),
          400: ErrorResponseSchema.describe('Cuerpo inválido (VALIDATION_ERROR)'),
          401: ErrorResponseSchema.describe(
            'Firma inválida o timestamp fuera de la ventana de 5 minutos (UNAUTHORIZED)',
          ),
          413: ErrorResponseSchema.describe('Cuerpo demasiado grande (PAYLOAD_TOO_LARGE)'),
          500: ErrorResponseSchema.describe(
            'Error interno (INTERNAL_ERROR); el proveedor reintentará el evento',
          ),
        },
      },
    },
    async (request, reply) => {
      const claim = await rejectingUnverified(request.log, () =>
        options.verifier.verify(request.body.signature),
      );
      if (!claim) {
        request.log.info('Repeated webhook ignored');
        return reply.code(204).send(null);
      }
      const event = toProviderEvent(request.body['event-data']);
      if (event) await releasingOnFailure(claim, () => options.handleProviderEvent.execute(event));
      return reply.code(204).send(null);
    },
  );
};

// Mismo mensaje en todos los casos; el motivo concreto solo va al log
async function rejectingUnverified(
  log: FastifyBaseLogger,
  verify: () => Promise<WebhookClaim | null>,
): Promise<WebhookClaim | null> {
  try {
    return await verify();
  } catch (error) {
    if (!(error instanceof WebhookRejectedError)) throw error;
    log.warn({ reason: error.reason }, 'Webhook rejected');
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid webhook signature');
  }
}

// Si el procesado falla se responde 500 y el proveedor reintenta: el reintento no es una repetición
async function releasingOnFailure(claim: WebhookClaim, process: () => Promise<void>) {
  try {
    await process();
  } catch (error) {
    await claim.release();
    throw error;
  }
}
