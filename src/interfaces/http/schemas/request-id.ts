import { z } from 'zod';

// Opcional: si no llega o no tiene un formato válido, el servicio genera uno
export const RequestIdHeadersSchema = z.object({
  'x-request-id': z
    .string()
    .optional()
    .describe('Identificador de la petición para correlacionar logs; se devuelve en la respuesta'),
});
