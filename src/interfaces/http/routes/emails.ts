import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
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

export interface EmailRoutesOptions {
  apiClients: ApiClientRepository;
  queueEmail: QueueEmail;
  getEmailStatus: GetEmailStatus;
  maxAttachmentsBytes: number;
}

// Rutas autenticadas por API key: la autenticación va antes que el rate limit
export const emailRoutes: FastifyPluginAsync<EmailRoutesOptions> = async (scope, options) => {
  const app = scope.withTypeProvider<ZodTypeProvider>();
  app.decorateRequest('client', null);
  app.addHook('onRequest', authenticate(options.apiClients));

  app.post(
    '/v1/emails',
    {
      schema: {
        headers: EmailRequestHeadersSchema,
        body: EmailRequestSchema,
        response: {
          202: EmailAcceptedSchema.describe('Mensaje creado y encolado'),
          200: EmailAcceptedSchema.describe(
            'Mensaje ya existente con la misma Idempotency-Key y el mismo cuerpo',
          ),
          400: ErrorResponseSchema.describe('Petición inválida (VALIDATION_ERROR)'),
          401: ErrorResponseSchema.describe('API key ausente o inválida (UNAUTHORIZED)'),
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
        params: EmailIdParamsSchema,
        response: {
          200: EmailStatusResponseSchema,
          400: ErrorResponseSchema.describe(
            'Identificador con formato inválido (VALIDATION_ERROR)',
          ),
          401: ErrorResponseSchema.describe('API key ausente o inválida (UNAUTHORIZED)'),
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
