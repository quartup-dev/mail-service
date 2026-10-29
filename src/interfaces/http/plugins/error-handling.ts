import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifySchemaValidationError } from 'fastify/types/schema';
import { EmailRequestRejectedError, type EmailRequestRejectionCode } from '../../../domain/errors';
import { ApiError, type ErrorCode, type ValidationIssue } from '../api-error';

const STATUS_BY_REJECTION: Record<EmailRequestRejectionCode, number> = {
  TRANSPORT_NOT_ALLOWED: 403,
  FROM_DOMAIN_NOT_ALLOWED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  SMTP_HOST_NOT_ALLOWED: 422,
  API_TRANSPORT_NOT_CONFIGURED: 422,
};

// Un único manejador de errores y de rutas no encontradas para toda la app (formato de 3.5)
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) =>
    sendError(request, reply, 404, 'NOT_FOUND', `Route ${request.method} ${request.url} not found`),
  );

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return sendError(request, reply, error.statusCode, error.code, error.message, error.details);
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendError(request, reply, 400, 'VALIDATION_ERROR', 'Invalid request', issuesOf(error));
    }
    if (error instanceof EmailRequestRejectedError) {
      return sendError(request, reply, STATUS_BY_REJECTION[error.code], error.code, error.message);
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendError(request, reply, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    // Errores del cliente detectados por Fastify antes de validar (JSON mal formado, tipo de contenido...)
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return sendError(request, reply, 400, 'VALIDATION_ERROR', error.message);
    }
    // El detalle va al log con el requestId; la respuesta no revela nada interno
    request.log.error({ err: error }, 'Unhandled error');
    return sendError(request, reply, 500, 'INTERNAL_ERROR', 'Internal server error');
  });
}

function issuesOf(error: { validation: FastifySchemaValidationError[] }): ValidationIssue[] {
  return error.validation.map((issue) => ({
    path: issue.instancePath,
    message: issue.message ?? '',
    code: issue.keyword,
  }));
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
