import { z } from 'zod';

export type ProcessKind = 'api' | 'worker' | 'keys-cli' | 'suppressions-cli';

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(
    readonly kind: ProcessKind,
    readonly issues: string[],
  ) {
    super(`Invalid configuration for ${kind}:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

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

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Clave de 32 bytes en base64. El mensaje de error nunca incluye el valor
const key32 = z
  .string()
  .refine(
    (value) => BASE64.test(value) && Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes encoded in base64',
  )
  .transform((value) => Buffer.from(value, 'base64'));

// Grupos de variables; cada proceso combina los que usa
const commonFields = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string(),
};

const serverFields = {
  REDIS_URL: z.string(),
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
};

const apiOnlyFields = {
  PORT: positiveInt(3000),
  ALLOWED_FROM_DOMAINS: commaList,
  API_KEY_PEPPER: key32,
  RATE_LIMIT_DEFAULT_PER_MINUTE: positiveInt(120),
  MAX_BODY_BYTES: positiveInt(15_728_640),
  MAX_ATTACHMENTS_BYTES: positiveInt(10_485_760),
};

type CommonEnv = z.output<z.ZodObject<typeof commonFields>>;
type ServerEnv = z.output<z.ZodObject<typeof serverFields>>;

const toCommon = (env: CommonEnv) => ({
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
});

const toServer = (env: ServerEnv) => ({
  redisUrl: env.REDIS_URL,
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
});

const schemas = {
  api: z.object({ ...commonFields, ...serverFields, ...apiOnlyFields }).transform((env) => ({
    ...toCommon(env),
    ...toServer(env),
    port: env.PORT,
    allowedFromDomains: env.ALLOWED_FROM_DOMAINS,
    apiKeyPepper: env.API_KEY_PEPPER,
    rateLimitDefaultPerMinute: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
    maxBodyBytes: env.MAX_BODY_BYTES,
    maxAttachmentsBytes: env.MAX_ATTACHMENTS_BYTES,
  })),
  worker: z.object({ ...commonFields, ...serverFields }).transform((env) => ({
    ...toCommon(env),
    ...toServer(env),
  })),
  'keys-cli': z.object({ ...commonFields, API_KEY_PEPPER: key32 }).transform((env) => ({
    ...toCommon(env),
    apiKeyPepper: env.API_KEY_PEPPER,
  })),
  'suppressions-cli': z.object(commonFields).transform(toCommon),
};

type Schemas = typeof schemas;

export type ApiConfig = z.output<Schemas['api']>;
export type WorkerConfig = z.output<Schemas['worker']>;
export type KeysCliConfig = z.output<Schemas['keys-cli']>;
export type SuppressionsCliConfig = z.output<Schemas['suppressions-cli']>;

export function loadConfig<K extends ProcessKind>(kind: K, env: Env): z.output<Schemas[K]> {
  const result = schemas[kind].safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(kind, issues);
  }
  return result.data as z.output<Schemas[K]>;
}
