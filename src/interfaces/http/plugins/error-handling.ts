import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, type ErrorCode, type ValidationIssue } from '../api-error';

// Un único manejador de errores y de rutas no encontradas para toda la app (formato de 3.5)
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) =>
    sendError(request, reply, 404, 'NOT_FOUND', `Route ${request.method} ${request.url} not found`),
  );

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return sendError(request, reply, error.statusCode, error.code, error.message, error.details);
    }
    // El detalle va al log con el requestId; la respuesta no revela nada interno
    request.log.error({ err: error }, 'Unhandled error');
    return sendError(request, reply, 500, 'INTERNAL_ERROR', 'Internal server error');
  });
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details: ValidationIssue[] = [],
) {
  return reply.code(statusCode).send({ error: { code, message, details, requestId: request.id } });
}
