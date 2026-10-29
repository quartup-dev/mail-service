import { z } from 'zod';
import { ERROR_CODES } from '../api-error';

export const ErrorCodeSchema = z.enum(ERROR_CODES).meta({
  id: 'ErrorCode',
  description: 'Código de error del servicio',
});

export const ValidationIssueSchema = z
  .object({
    path: z.string().describe('Ruta JSON Pointer del campo, p. ej. /to/0/email'),
    message: z.string(),
    code: z.string().describe('Código de la validación que falló'),
  })
  .meta({ id: 'ValidationIssue', description: 'Error de validación de un campo' });

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.array(ValidationIssueSchema).describe('Solo con VALIDATION_ERROR'),
      requestId: z.string().describe('Igual que la cabecera X-Request-Id'),
    }),
  })
  .meta({ id: 'ErrorResponse', description: 'Formato común de todos los errores' });
