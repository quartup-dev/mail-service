import { z } from 'zod';

export type ProcessKind = 'api' | 'worker' | 'keys-cli' | 'suppressions-cli';

type Env = Record<string, string | undefined>;

const positiveInt = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const key32 = z
  .string()
  .transform((value) => Buffer.from(value, 'base64'));

const apiSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PORT: positiveInt(3000),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    ALLOWED_FROM_DOMAINS: commaList,
    API_KEY_PEPPER: key32,
    RATE_LIMIT_DEFAULT_PER_MINUTE: positiveInt(120),
    MAX_BODY_BYTES: positiveInt(15_728_640),
    MAX_ATTACHMENTS_BYTES: positiveInt(10_485_760),
    SMTP_CREDENTIALS_ENCRYPTION_KEY: key32,
    SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: key32.optional(),
    SMTP_ALLOWED_HOSTS: commaList,
    SMTP_ALLOWED_PRIVATE_HOSTS: commaList,
    SMTP_POOL_MAX_CONNECTIONS: positiveInt(5),
    SMTP_RATE_LIMIT_PER_SECOND: positiveInt(5),
    SMTP_TRANSPORT_CACHE_TTL_MS: positiveInt(300_000),
    SMTP_TRANSPORT_CACHE_MAX: positiveInt(50),
    SMTP_CONNECTION_TIMEOUT_MS: positiveInt(10_000),
    SMTP_GREETING_TIMEOUT_MS: positiveInt(10_000),
    SMTP_SOCKET_TIMEOUT_MS: positiveInt(30_000),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    allowedFromDomains: env.ALLOWED_FROM_DOMAINS,
    apiKeyPepper: env.API_KEY_PEPPER,
    rateLimitDefaultPerMinute: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
    maxBodyBytes: env.MAX_BODY_BYTES,
    maxAttachmentsBytes: env.MAX_ATTACHMENTS_BYTES,
    smtpEncryptionKey: env.SMTP_CREDENTIALS_ENCRYPTION_KEY,
    smtpEncryptionKeyPrevious: env.SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS,
    mailApiProvider: undefined,
    smtp: {
      allowedHosts: env.SMTP_ALLOWED_HOSTS,
      allowedPrivateHosts: env.SMTP_ALLOWED_PRIVATE_HOSTS,
      poolMaxConnections: env.SMTP_POOL_MAX_CONNECTIONS,
      rateLimitPerSecond: env.SMTP_RATE_LIMIT_PER_SECOND,
      transportCacheTtlMs: env.SMTP_TRANSPORT_CACHE_TTL_MS,
      transportCacheMax: env.SMTP_TRANSPORT_CACHE_MAX,
      connectionTimeoutMs: env.SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeoutMs: env.SMTP_GREETING_TIMEOUT_MS,
      socketTimeoutMs: env.SMTP_SOCKET_TIMEOUT_MS,
    },
  }));

export type ApiConfig = z.output<typeof apiSchema>;

export function loadConfig(_kind: 'api', env: Env): ApiConfig {
  return apiSchema.parse(env);
}
