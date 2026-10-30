import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HandleProviderEvent } from '../../../application/handle-provider-event';
import type { MailgunWebhookVerifier } from '../../../infrastructure/webhooks/mailgun-webhook-verifier';
import type { SnsMessageVerifier } from '../../../infrastructure/webhooks/sns-message-verifier';
import {
  WebhookRejectedError,
  type WebhookClaim,
} from '../../../infrastructure/webhooks/webhook-verification';
import { ApiError } from '../api-error';
import { ErrorResponseSchema } from '../schemas/errors';
import { MailgunWebhookRequestSchema, SnsMessageSchema } from '../schemas/webhooks';
import { toProviderEvent } from '../webhooks/mailgun-events';
import { SesEventSchema, toProviderEvents } from '../webhooks/ses-events';

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

export interface SesWebhookOptions {
  verifier: SnsMessageVerifier;
  subscriptions: { confirmSubscription(subscribeUrl: string): Promise<void> };
  handleProviderEvent: HandleProviderEvent;
}

// SNS publica los eventos de SES en un topic y los entrega por HTTPS
export const sesWebhookRoutes: FastifyPluginAsync<SesWebhookOptions> = async (scope, options) => {
  const app = scope.withTypeProvider<ZodTypeProvider>();
  // SNS envía el JSON como text/plain. El parser solo existe dentro de este plugin
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new ApiError(400, 'VALIDATION_ERROR', 'Body is not valid JSON'));
    }
  });

  app.post(
    '/v1/webhooks/ses',
    {
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      schema: {
        summary: 'Recibe por SNS los eventos de entrega de SES',
        description:
          'Notificaciones del topic de SNS del configuration set de SES. Confirma automáticamente las suscripciones de los topics de SES_SNS_TOPIC_ARNS.',
        tags: ['webhooks'],
        body: SnsMessageSchema,
        response: {
          204: z.null().describe('Evento procesado, ignorado o repetido, o suscripción confirmada'),
          400: ErrorResponseSchema.describe(
            'Cuerpo inválido o Message que no es un evento de SES (VALIDATION_ERROR)',
          ),
          401: ErrorResponseSchema.describe(
            'Firma inválida, certificado o topic no permitidos, o Timestamp fuera de plazo (UNAUTHORIZED)',
          ),
          413: ErrorResponseSchema.describe('Cuerpo demasiado grande (PAYLOAD_TOO_LARGE)'),
          500: ErrorResponseSchema.describe(
            'Error interno (INTERNAL_ERROR); SNS reintentará la entrega',
          ),
        },
      },
    },
    async (request, reply) => {
      const message = request.body;
      const claim = await rejectingUnverified(request.log, () => options.verifier.verify(message));
      if (!claim) {
        request.log.info('Repeated webhook ignored');
        return reply.code(204).send(null);
      }
      await releasingOnFailure(claim, async () => {
        if (message.Type === 'Notification') {
          for (const event of toProviderEvents(parseSesEvent(message.Message))) {
            await options.handleProviderEvent.execute(event);
          }
        } else if (message.Type === 'SubscriptionConfirmation' && message.SubscribeURL) {
          // El verificador ya comprobó el topic y que SubscribeURL es de SNS en la región
          await options.subscriptions.confirmSubscription(message.SubscribeURL);
          request.log.info({ topicArn: message.TopicArn }, 'SNS subscription confirmed');
        } else {
          request.log.warn(
            { topicArn: message.TopicArn, type: message.Type },
            'SNS message ignored',
          );
        }
      });
      return reply.code(204).send(null);
    },
  );
};

function parseSesEvent(message: string) {
  const invalid = () => new ApiError(400, 'VALIDATION_ERROR', 'Message is not an SES event');
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    throw invalid();
  }
  const parsed = SesEventSchema.safeParse(json);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

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
