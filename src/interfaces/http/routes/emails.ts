import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { GetEmailStatus } from '../../../application/get-email-status';
import type { ApiClientRepository } from '../../../application/ports/api-client-repository';
import type { QueueEmail } from '../../../application/queue-email';
import { ApiError } from '../api-error';
import { authenticate, clientOf } from '../plugins/authentication';
import { toEmailAccepted, toEmailStatusResponse } from '../presenters';
import {
  EmailAcceptedSchema,
  EmailIdParamsSchema,
  EmailRequestHeadersSchema,
  EmailRequestSchema,
  EmailStatusResponseSchema,
} from '../schemas/emails';
import { ErrorResponseSchema } from '../schemas/errors';
import { RequestIdHeadersSchema } from '../schemas/request-id';

// Un objeto nuevo por ruta: uno compartido aparecería como ancla y alias en el YAML
const bearerAuth = () => [{ bearerAuth: [] }];
const RATE_LIMIT_WINDOW_MS = 60_000; // ventana fija de un minuto por cliente

export interface EmailRoutesOptions {
  apiClients: ApiClientRepository;
  queueEmail: QueueEmail;
  getEmailStatus: GetEmailStatus;
  maxAttachmentsBytes: number;
  rateLimit: { defaultPerMinute: number; redis?: Redis };
}

// Rutas autenticadas por API key: la autenticación va antes que el rate limit
export const emailRoutes: FastifyPluginAsync<EmailRoutesOptions> = async (scope, options) => {
  const app = scope.withTypeProvider<ZodTypeProvider>();
  app.decorateRequest('client', null);
  app.addHook('onRequest', authenticate(options.apiClients));
  // Va después de la autenticación (los hooks de la instancia corren antes que los de ruta que
  // añade el plugin): una petición sin key válida no consume el límite de nadie
  await app.register(rateLimit, {
    hook: 'onRequest',
    timeWindow: RATE_LIMIT_WINDOW_MS,
    nameSpace: 'mail-service:rate-limit:',
    ...(options.rateLimit.redis && { redis: options.rateLimit.redis }),
    // Si Redis falla se deja pasar la petición: mejor sin límite que sin envíos
    skipOnError: true,
    keyGenerator: (request) => clientOf(request).id,
    max: (request) => clientOf(request).rateLimitPerMinute ?? options.rateLimit.defaultPerMinute,
    errorResponseBuilder: (_request, context) => {
      const seconds = Math.ceil(context.ttl / 1_000);
      return new ApiError(429, 'RATE_LIMITED', `Rate limit exceeded, retry in ${seconds} seconds`);
    },
  });

  app.post(
    '/v1/emails',
    {
      schema: {
        summary: 'Solicita el envío de un correo',
        description:
          'Valida la petición, guarda el mensaje y lo encola. El envío es asíncrono: consulta su estado con GET /v1/emails/{id}.',
        tags: ['emails'],
        security: bearerAuth(),
        headers: EmailRequestHeadersSchema.extend(RequestIdHeadersSchema.shape),
        body: EmailRequestSchema,
        response: {
          202: EmailAcceptedSchema.describe('Mensaje creado y encolado'),
          200: EmailAcceptedSchema.describe(
            'Mensaje ya existente con la misma Idempotency-Key y el mismo cuerpo',
          ),
          400: ErrorResponseSchema.describe('Petición inválida (VALIDATION_ERROR)'),
          401: ErrorResponseSchema.describe('API key ausente o inválida (UNAUTHORIZED)'),
          429: ErrorResponseSchema.describe('Límite de peticiones superado (RATE_LIMITED)'),
          403: ErrorResponseSchema.describe(
            'Transporte o dominio de from no permitidos (TRANSPORT_NOT_ALLOWED, FROM_DOMAIN_NOT_ALLOWED)',
          ),
          409: ErrorResponseSchema.describe(
            'Idempotency-Key ya usada con otro cuerpo (IDEMPOTENCY_CONFLICT)',
          ),
          413: ErrorResponseSchema.describe('Cuerpo demasiado grande (PAYLOAD_TOO_LARGE)'),
          422: ErrorResponseSchema.describe(
            'La política o la configuración impiden el envío (SMTP_HOST_NOT_ALLOWED, API_TRANSPORT_NOT_CONFIGURED)',
          ),
          500: ErrorResponseSchema.describe('Error interno (INTERNAL_ERROR)'),
        },
      },
    },
    async (request, reply) => {
      ensureAttachmentsWithinLimit(request.body.attachments ?? [], options.maxAttachmentsBytes);
      const idempotencyKey = request.headers['idempotency-key'];
      const { email, created } = await options.queueEmail.execute({
        client: clientOf(request),
        request: request.body,
        requestId: request.id,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
      return reply.code(created ? 202 : 200).send(toEmailAccepted(email));
    },
  );

  app.get(
    '/v1/emails/:id',
    {
      schema: {
        summary: 'Consulta el estado de envío y de entrega de un mensaje',
        tags: ['emails'],
        security: bearerAuth(),
        headers: RequestIdHeadersSchema,
        params: EmailIdParamsSchema,
        response: {
          200: EmailStatusResponseSchema.describe('Estado del mensaje'),
          400: ErrorResponseSchema.describe(
            'Identificador con formato inválido (VALIDATION_ERROR)',
          ),
          401: ErrorResponseSchema.describe('API key ausente o inválida (UNAUTHORIZED)'),
          429: ErrorResponseSchema.describe('Límite de peticiones superado (RATE_LIMITED)'),
          404: ErrorResponseSchema.describe('Mensaje inexistente o de otro cliente (NOT_FOUND)'),
          500: ErrorResponseSchema.describe('Error interno (INTERNAL_ERROR)'),
        },
      },
    },
    async (request) => {
      const email = await options.getEmailStatus.execute({
        clientId: clientOf(request).id,
        emailId: request.params.id,
      });
      if (!email) throw new ApiError(404, 'NOT_FOUND', 'Email not found');
      return toEmailStatusResponse(email);
    },
  );
};

// El límite se aplica al tamaño decodificado de todos los adjuntos juntos
function ensureAttachmentsWithinLimit(
  attachments: Array<{ contentBase64: string }>,
  maxBytes: number,
): void {
  const total = attachments.reduce(
    (sum, attachment) => sum + Buffer.byteLength(attachment.contentBase64, 'base64'),
    0,
  );
  if (total > maxBytes) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
      {
        path: '/attachments',
        message: `decoded attachments must not exceed ${maxBytes} bytes`,
        code: 'too_big',
      },
    ]);
  }
}
