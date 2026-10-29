import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type ProcessKind } from '../../../src/infrastructure/config';

type Env = Record<string, string | undefined>;

const KEY_A = Buffer.alloc(32, 1).toString('base64');
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
    it.each(PROCESS_KINDS.filter((kind) => requiredIn.includes(kind)))('is required in %s', (kind) => {
      const env = { ...validEnvFor[kind](), [variable]: undefined };

      expect(configErrorOf(kind, env).message).toContain(variable);
    });

    it.each(PROCESS_KINDS.filter((kind) => !requiredIn.includes(kind)))(
      'is not required in %s',
      (kind) => {
        expect(() => loadConfig(kind, validEnvFor[kind]())).not.toThrow();
      },
    );
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
