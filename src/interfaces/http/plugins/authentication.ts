import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiClient,
  ApiClientRepository,
} from '../../../application/ports/api-client-repository';
import { ApiError } from '../api-error';

declare module 'fastify' {
  interface FastifyRequest {
    client: ApiClient | null;
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

// Mismo mensaje en todos los casos: no se revela si la key existe, está revocada o caducada
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key');

export function authenticate(apiClients: ApiClientRepository) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const client = key ? await apiClients.authenticate(key) : null;
    if (!client) throw unauthorized();
    request.client = client;
    // reply.log es otro logger (el de "request completed"): ambos deben llevar el cliente
    request.log = request.log.child({ clientId: client.id });
    reply.log = request.log;
  };
}

// En las rutas autenticadas el hook ya ha dejado el cliente
export function clientOf(request: FastifyRequest): ApiClient {
  if (!request.client) throw unauthorized();
  return request.client;
}
