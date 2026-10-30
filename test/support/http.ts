import { Writable } from 'node:stream';
import { GetEmailStatus } from '../../src/application/get-email-status';
import { HandleProviderEvent } from '../../src/application/handle-provider-event';
import { QueueEmail } from '../../src/application/queue-email';
import { hashApiKeySecret } from '../../src/infrastructure/auth/api-keys';
import { InMemoryApiClientRepository } from '../../src/infrastructure/auth/in-memory-api-client-repository';
import { AesGcmSecretBox } from '../../src/infrastructure/crypto/aes-gcm-secret-box';
import { InMemoryEmailRepository } from '../../src/infrastructure/db/in-memory/in-memory-email-repository';
import { InMemorySuppressionRepository } from '../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { createLogger } from '../../src/infrastructure/logger';
import { InMemoryReplayGuard } from '../../src/infrastructure/webhooks/in-memory-replay-guard';
import { MailgunWebhookVerifier } from '../../src/infrastructure/webhooks/mailgun-webhook-verifier';
import { buildApp, type AppDependencies } from '../../src/interfaces/http/app';
import { FakeClock } from './fake-clock';
import { FakeEmailQueue } from './fake-email-queue';
import { FakeSmtpHostGuard } from './fake-smtp-host-guard';
import { SequentialIds } from './sequential-ids';
import { MAILGUN_SIGNING_KEY } from './webhooks';

const PEPPER = Buffer.alloc(32, 3);

// Keys de los clientes de prueba: billing solo api y con límite propio; crm, ambos transportes
export const BILLING_KEY = 'ms_billing_billing-secret';
export const CRM_KEY = 'ms_crm_crm_secret-with-dashes';

export const auth = (key: string) => ({ authorization: `Bearer ${key}` });

export interface TestAppOptions {
  apiProviderName?: 'mailgun' | 'ses' | null;
  limits?: Partial<AppDependencies['limits']>;
  readiness?: Partial<AppDependencies['readiness']>;
}

// App completa con adaptadores en memoria y fakes; los logs se capturan en `logs`
export function buildTestApp(options: TestAppOptions = {}) {
  const clock = new FakeClock();
  const emails = new InMemoryEmailRepository(clock);
  const suppressions = new InMemorySuppressionRepository(clock);
  const replayGuard = new InMemoryReplayGuard(clock);
  const apiProviderName =
    options.apiProviderName === undefined ? 'mailgun' : options.apiProviderName;
  const queue = new FakeEmailQueue();
  const smtpHostGuard = new FakeSmtpHostGuard();
  const secretBox = new AesGcmSecretBox({ active: Buffer.alloc(32, 1) });
  const apiClients = new InMemoryApiClientRepository(PEPPER, clock);
  apiClients.addClient({
    id: 'billing',
    name: 'Facturación',
    status: 'active',
    allowedTransports: ['api'],
    allowedFromDomains: ['example.com'],
    rateLimitPerMinute: 3,
  });
  apiClients.addClient({
    id: 'crm',
    name: 'CRM',
    status: 'active',
    allowedTransports: ['smtp', 'api'],
  });
  for (const [clientId, key] of [
    ['billing', BILLING_KEY],
    ['crm', CRM_KEY],
  ] as const) {
    apiClients.addKey({
      clientId,
      keyId: 'k1',
      hash: hashApiKeySecret(key.split('_').slice(2).join('_'), PEPPER),
      status: 'active',
      expiresAt: null,
    });
  }

  const logs: string[] = [];
  const logger = createLogger(
    { level: 'debug' },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    }),
  );

  const app = buildApp({
    logger,
    limits: {
      maxBodyBytes: 1_048_576,
      maxAttachmentsBytes: 1_000,
      rateLimitDefaultPerMinute: 120,
      ...options.limits,
    },
    apiClients,
    queueEmail: new QueueEmail({
      emails,
      queue,
      smtpHostGuard,
      secretBox,
      ids: new SequentialIds(),
      logger,
      apiProviderName,
      allowedFromDomains: ['example.com'],
      requestHashPepper: PEPPER,
    }),
    getEmailStatus: new GetEmailStatus({ emails }),
    readiness: {
      postgres: async () => {},
      redis: async () => {},
      apiProvider: null,
      ...options.readiness,
    },
    version: '0.0.0-test',
    // Como en producción, solo el webhook del proveedor configurado
    webhooks: {
      handleProviderEvent: new HandleProviderEvent({ emails, suppressions, clock }),
      mailgun:
        apiProviderName === 'mailgun'
          ? new MailgunWebhookVerifier({ signingKey: MAILGUN_SIGNING_KEY, replayGuard, clock })
          : null,
    },
  });

  return {
    app,
    clock,
    emails,
    suppressions,
    replayGuard,
    queue,
    smtpHostGuard,
    logs: () => logs.join(''),
  };
}
