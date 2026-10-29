import type { FastifyInstance } from 'fastify';
import { GetEmailStatus } from '../../application/get-email-status';
import type { EmailQueue } from '../../application/ports/email-queue';
import { QueueEmail } from '../../application/queue-email';
import { InMemoryApiClientRepository } from '../../infrastructure/auth/in-memory-api-client-repository';
import { AesGcmSecretBox } from '../../infrastructure/crypto/aes-gcm-secret-box';
import { UuidV7IdGenerator } from '../../infrastructure/crypto/uuid-v7-id-generator';
import { InMemoryEmailRepository } from '../../infrastructure/db/in-memory/in-memory-email-repository';
import { createLogger } from '../../infrastructure/logger';
import { UnavailableSmtpHostGuard } from '../../infrastructure/providers/unavailable';
import { SystemClock } from '../../infrastructure/system-clock';
import { buildApp } from './app';

// Ninguna de estas piezas se usa al generar la especificación: solo hacen falta para montar las rutas
const UNUSED_KEY = Buffer.alloc(32);
const noQueue: EmailQueue = { enqueue: async () => {}, close: async () => {} };

// App para generar la especificación sin servicios externos ni variables de entorno
export function buildOpenApiApp(version: string): FastifyInstance {
  const clock = new SystemClock();
  const emails = new InMemoryEmailRepository(clock);
  return buildApp({
    limits: {
      maxBodyBytes: 1_048_576,
      maxAttachmentsBytes: 1_048_576,
      rateLimitDefaultPerMinute: 1,
    },
    apiClients: new InMemoryApiClientRepository(UNUSED_KEY, clock),
    queueEmail: new QueueEmail({
      emails,
      queue: noQueue,
      smtpHostGuard: new UnavailableSmtpHostGuard(),
      secretBox: new AesGcmSecretBox({ active: UNUSED_KEY }),
      ids: new UuidV7IdGenerator(),
      logger: createLogger({ level: 'silent' }),
      apiProviderName: null,
      allowedFromDomains: [],
      requestHashPepper: UNUSED_KEY,
    }),
    getEmailStatus: new GetEmailStatus({ emails }),
    readiness: { postgres: async () => {}, redis: async () => {}, apiProvider: null },
    version,
  });
}

export async function generateOpenApiYaml(version: string): Promise<string> {
  const app = buildOpenApiApp(version);
  try {
    await app.ready();
    return app.swagger({ yaml: true });
  } finally {
    await app.close();
  }
}
