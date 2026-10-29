import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';

// Se acepta el X-Request-Id del llamador si tiene un formato razonable; si no, se genera un UUID
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function generateRequestId(request: IncomingMessage): string {
  const incoming = request.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

export function exposeRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
}
