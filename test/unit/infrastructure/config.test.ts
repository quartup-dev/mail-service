import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type ProcessKind } from '../../../src/infrastructure/config';

type Env = Record<string, string | undefined>;

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const PEPPER = Buffer.alloc(32, 3).toString('base64');

const baseEnv = (): Env => ({ DATABASE_URL: 'postgres://mail:mail@localhost:5432/mail' });

const apiEnv = (): Env => ({
  ...baseEnv(),
  REDIS_URL: 'redis://localhost:6379',
  SMTP_CREDENTIALS_ENCRYPTION_KEY: KEY_A,
  API_KEY_PEPPER: PEPPER,
});

const workerEnv = (): Env => ({
  ...baseEnv(),
  REDIS_URL: 'redis://localhost:6379',
  SMTP_CREDENTIALS_ENCRYPTION_KEY: KEY_A,
});

const keysCliEnv = (): Env => ({ ...baseEnv(), API_KEY_PEPPER: PEPPER });

const suppressionsCliEnv = (): Env => baseEnv();

const validEnvFor: Record<ProcessKind, () => Env> = {
  api: apiEnv,
  worker: workerEnv,
  'keys-cli': keysCliEnv,
  'suppressions-cli': suppressionsCliEnv,
};

const PROCESS_KINDS = Object.keys(validEnvFor) as ProcessKind[];

function configErrorOf(kind: ProcessKind, env: Env): ConfigError {
  try {
    loadConfig(kind, env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error(`loadConfig('${kind}') did not fail`);
}

describe('loadConfig', () => {
  it.each(PROCESS_KINDS)('requires DATABASE_URL in %s and names it in the error', (kind) => {
    const env = { ...validEnvFor[kind](), DATABASE_URL: undefined };

    const error = configErrorOf(kind, env);

    expect(error.message).toContain('DATABASE_URL');
  });

  describe.each([
    { variable: 'REDIS_URL', requiredIn: ['api', 'worker'] },
    { variable: 'SMTP_CREDENTIALS_ENCRYPTION_KEY', requiredIn: ['api', 'worker'] },
    { variable: 'API_KEY_PEPPER', requiredIn: ['api', 'keys-cli'] },
  ])('$variable', ({ variable, requiredIn }) => {
    it.each(PROCESS_KINDS.filter((kind) => requiredIn.includes(kind)))(
      'is required in %s',
      (kind) => {
        const env = { ...validEnvFor[kind](), [variable]: undefined };

        expect(configErrorOf(kind, env).message).toContain(variable);
      },
    );

    it.each(PROCESS_KINDS.filter((kind) => !requiredIn.includes(kind)))(
      'is not required in %s',
      (kind) => {
        expect(() => loadConfig(kind, validEnvFor[kind]())).not.toThrow();
      },
    );
  });

  describe.each(['SMTP_CREDENTIALS_ENCRYPTION_KEY', 'API_KEY_PEPPER'])('%s', (variable) => {
    it.each([
      ['16 bytes', Buffer.alloc(16, 7).toString('base64')],
      ['33 bytes', Buffer.alloc(33, 7).toString('base64')],
      ['not base64', 'this is not base64 but has enough characters!!'],
    ])('rejects a value of %s without revealing it', (_label, value) => {
      const env = { ...apiEnv(), [variable]: value };

      const error = configErrorOf('api', env);

      expect(error.message).toContain(variable);
      expect(error.message).not.toContain(value);
    });
  });

  describe('SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS', () => {
    it.each(['api', 'worker'] as const)(
      'is loaded in %s when it differs from the active key',
      (kind) => {
        const env = { ...validEnvFor[kind](), SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: KEY_B };

        expect(loadConfig(kind, env).smtpEncryptionKeyPrevious).toEqual(
          Buffer.from(KEY_B, 'base64'),
        );
      },
    );

    it.each(['api', 'worker'] as const)(
      'is rejected in %s when it equals the active key',
      (kind) => {
        const env = { ...validEnvFor[kind](), SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: KEY_A };

        expect(configErrorOf(kind, env).message).toContain(
          'SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS',
        );
      },
    );
  });

  it('loads a minimal worker environment and applies defaults', () => {
    const config = loadConfig('worker', workerEnv());

    expect(config).toMatchObject({
      nodeEnv: 'development',
      logLevel: 'info',
      databaseUrl: 'postgres://mail:mail@localhost:5432/mail',
      redisUrl: 'redis://localhost:6379',
      mailApiProvider: undefined,
      worker: {
        queues: ['api', 'smtp'],
        healthPort: 3001,
        apiConcurrency: 10,
        apiRateLimitPerSecond: 10,
        smtpConcurrency: 10,
        maxAttempts: 5,
        backoffBaseMs: 30_000,
      },
      maintenance: {
        sweepIntervalMs: 60_000,
        stalePendingAfterMs: 600_000,
        pendingMaxAgeMs: 86_400_000,
        payloadRetentionDays: 7,
        eventsRetentionDays: 90,
        messageRetentionDays: 365,
      },
    });
    expect(config.smtp.poolMaxConnections).toBe(5);
  });

  it.each([
    ['payload retention exceeds events retention', { PAYLOAD_RETENTION_DAYS: '91' }],
    ['events retention exceeds message retention', { EVENTS_RETENTION_DAYS: '366' }],
  ])('rejects retention periods out of order: %s', (_label, overrides) => {
    const env = { ...workerEnv(), ...overrides };

    expect(configErrorOf('worker', env).message).toMatch(/RETENTION_DAYS/);
  });

  it('accepts equal retention periods', () => {
    const env = {
      ...workerEnv(),
      PAYLOAD_RETENTION_DAYS: '30',
      EVENTS_RETENTION_DAYS: '30',
      MESSAGE_RETENTION_DAYS: '30',
    };

    expect(loadConfig('worker', env).maintenance.messageRetentionDays).toBe(30);
  });

  describe('WORKER_QUEUES', () => {
    it('accepts a single queue', () => {
      const env = { ...workerEnv(), WORKER_QUEUES: 'smtp' };

      expect(loadConfig('worker', env).worker.queues).toEqual(['smtp']);
    });

    it('rejects unknown queues', () => {
      const env = { ...workerEnv(), WORKER_QUEUES: 'api,maintenance' };

      expect(configErrorOf('worker', env).message).toContain('WORKER_QUEUES');
    });
  });

  describe('SMTP_ALLOWED_PRIVATE_HOSTS', () => {
    it.each(['api', 'worker'] as const)('is parsed as a trimmed list in %s', (kind) => {
      const env = { ...validEnvFor[kind](), SMTP_ALLOWED_PRIVATE_HOSTS: ' mailpit , localhost ,, ' };

      expect(loadConfig(kind, env).smtp.allowedPrivateHosts).toEqual(['mailpit', 'localhost']);
    });

    it.each(['api', 'worker'] as const)('must be empty in production for %s', (kind) => {
      const env = {
        ...validEnvFor[kind](),
        NODE_ENV: 'production',
        SMTP_ALLOWED_PRIVATE_HOSTS: 'mailpit',
      };

      expect(configErrorOf(kind, env).message).toContain('SMTP_ALLOWED_PRIVATE_HOSTS');
    });

    it.each(['api', 'worker'] as const)('may be empty in production for %s', (kind) => {
      const env = { ...validEnvFor[kind](), NODE_ENV: 'production', SMTP_ALLOWED_PRIVATE_HOSTS: '' };

      expect(loadConfig(kind, env).smtp.allowedPrivateHosts).toEqual([]);
    });
  });

  it('loads a minimal api environment and applies defaults', () => {
    const config = loadConfig('api', apiEnv());

    expect(config).toMatchObject({
      nodeEnv: 'development',
      logLevel: 'info',
      port: 3000,
      databaseUrl: 'postgres://mail:mail@localhost:5432/mail',
      redisUrl: 'redis://localhost:6379',
      allowedFromDomains: [],
      rateLimitDefaultPerMinute: 120,
      maxBodyBytes: 15_728_640,
      maxAttachmentsBytes: 10_485_760,
      mailApiProvider: undefined,
      smtp: {
        allowedHosts: [],
        allowedPrivateHosts: [],
        poolMaxConnections: 5,
        rateLimitPerSecond: 5,
        transportCacheTtlMs: 300_000,
        transportCacheMax: 50,
        connectionTimeoutMs: 10_000,
        greetingTimeoutMs: 10_000,
        socketTimeoutMs: 30_000,
      },
    });
    expect(config.smtpEncryptionKey).toEqual(Buffer.from(KEY_A, 'base64'));
    expect(config.smtpEncryptionKeyPrevious).toBeUndefined();
    expect(config.apiKeyPepper).toEqual(Buffer.from(PEPPER, 'base64'));
  });
});
