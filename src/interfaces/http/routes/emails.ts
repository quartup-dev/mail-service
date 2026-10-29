import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { GetEmailStatus } from '../../../application/get-email-status';
import type { ApiClientRepository } from '../../../application/ports/api-client-repository';
import { ApiError } from '../api-error';
import { authenticate, clientOf } from '../plugins/authentication';
import { toEmailStatusResponse } from '../presenters';
import { EmailIdParamsSchema, EmailStatusResponseSchema } from '../schemas/emails';
import { ErrorResponseSchema } from '../schemas/errors';

export interface EmailRoutesOptions {
  apiClients: ApiClientRepository;
  getEmailStatus: GetEmailStatus;
}

// Rutas autenticadas por API key: la autenticación va antes que el rate limit
export const emailRoutes: FastifyPluginAsync<EmailRoutesOptions> = async (scope, options) => {
  const app = scope.withTypeProvider<ZodTypeProvider>();
  app.decorateRequest('client', null);
  app.addHook('onRequest', authenticate(options.apiClients));

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
