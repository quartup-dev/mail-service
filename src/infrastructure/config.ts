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

const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

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

const workerOnlyFields = {
  WORKER_QUEUES: commaList
    .pipe(z.array(z.enum(['api', 'smtp'])))
    .transform((queues) => (queues.length > 0 ? queues : (['api', 'smtp'] as const))),
  WORKER_HEALTH_PORT: positiveInt(3001),
  WORKER_API_CONCURRENCY: positiveInt(10),
  WORKER_API_RATE_LIMIT_PER_SECOND: positiveInt(10),
  WORKER_SMTP_CONCURRENCY: positiveInt(10),
  WORKER_MAX_ATTEMPTS: positiveInt(5),
  WORKER_BACKOFF_BASE_MS: positiveInt(30_000),
  SWEEP_INTERVAL_MS: positiveInt(60_000),
  STALE_PENDING_AFTER_MS: positiveInt(600_000),
  PENDING_MAX_AGE_MS: positiveInt(86_400_000),
  PAYLOAD_RETENTION_DAYS: positiveInt(7),
  EVENTS_RETENTION_DAYS: positiveInt(90),
  MESSAGE_RETENTION_DAYS: positiveInt(365),
};

const requiredText = z.string().min(1);

// MAIL_API_PROVIDER vacío o ausente se normaliza a 'none' para poder discriminar
const normalizeProvider = (input: unknown) =>
  typeof input === 'object' && input !== null
    ? {
        ...input,
        MAIL_API_PROVIDER: (input as Env).MAIL_API_PROVIDER || 'none',
      }
    : input;

const noProvider = z.object({ MAIL_API_PROVIDER: z.literal('none') });

// La API solo necesita lo que usan los webhooks; el worker, lo que usa para enviar
const apiProviderFields = z.discriminatedUnion('MAIL_API_PROVIDER', [
  noProvider,
  z.object({
    MAIL_API_PROVIDER: z.literal('mailgun'),
    MAILGUN_WEBHOOK_SIGNING_KEY: requiredText,
  }),
  z.object({
    MAIL_API_PROVIDER: z.literal('ses'),
    AWS_REGION: requiredText,
    SES_SNS_TOPIC_ARNS: commaList.pipe(z.array(z.string()).min(1)),
  }),
]);

const workerProviderFields = z.discriminatedUnion('MAIL_API_PROVIDER', [
  noProvider,
  z.object({
    MAIL_API_PROVIDER: z.literal('mailgun'),
    MAILGUN_API_KEY: requiredText,
    MAILGUN_DOMAIN: requiredText,
    MAILGUN_REGION: z.enum(['eu', 'us']).default('eu'),
  }),
  z.object({
    MAIL_API_PROVIDER: z.literal('ses'),
    AWS_REGION: requiredText,
    SES_CONFIGURATION_SET: z.string().optional(),
  }),
]);

const toApiProvider = (env: z.output<typeof apiProviderFields>) => {
  switch (env.MAIL_API_PROVIDER) {
    case 'none':
      return undefined;
    case 'mailgun':
      return { name: 'mailgun' as const, webhookSigningKey: env.MAILGUN_WEBHOOK_SIGNING_KEY };
    case 'ses':
      return { name: 'ses' as const, region: env.AWS_REGION, snsTopicArns: env.SES_SNS_TOPIC_ARNS };
  }
};

const toWorkerProvider = (env: z.output<typeof workerProviderFields>) => {
  switch (env.MAIL_API_PROVIDER) {
    case 'none':
      return undefined;
    case 'mailgun':
      return {
        name: 'mailgun' as const,
        apiKey: env.MAILGUN_API_KEY,
        domain: env.MAILGUN_DOMAIN,
        region: env.MAILGUN_REGION,
      };
    case 'ses':
      return {
        name: 'ses' as const,
        region: env.AWS_REGION,
        configurationSet: env.SES_CONFIGURATION_SET || undefined,
      };
  }
};

type CommonEnv = z.output<z.ZodObject<typeof commonFields>>;
type ServerEnv = z.output<z.ZodObject<typeof serverFields>>;
type WorkerEnv = z.output<z.ZodObject<typeof workerOnlyFields>>;

// Reglas que relacionan varias variables de API y worker
const checkServerRules = (env: CommonEnv & ServerEnv, ctx: z.RefinementCtx) => {
  const previous = env.SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
  if (previous?.equals(env.SMTP_CREDENTIALS_ENCRYPTION_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS'],
      message: 'must differ from SMTP_CREDENTIALS_ENCRYPTION_KEY',
    });
  }
  if (env.NODE_ENV === 'production' && env.SMTP_ALLOWED_PRIVATE_HOSTS.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_ALLOWED_PRIVATE_HOSTS'],
      message: 'must be empty in production',
    });
  }
};

const checkWorkerRules = (env: WorkerEnv, ctx: z.RefinementCtx) => {
  if (env.PAYLOAD_RETENTION_DAYS > env.EVENTS_RETENTION_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['PAYLOAD_RETENTION_DAYS'],
      message: 'must not exceed EVENTS_RETENTION_DAYS',
    });
  }
  if (env.EVENTS_RETENTION_DAYS > env.MESSAGE_RETENTION_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['EVENTS_RETENTION_DAYS'],
      message: 'must not exceed MESSAGE_RETENTION_DAYS',
    });
  }
};

const toCommon = (env: CommonEnv) => ({
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
});

const toServer = (env: ServerEnv) => ({
  redisUrl: env.REDIS_URL,
  smtpEncryptionKey: env.SMTP_CREDENTIALS_ENCRYPTION_KEY,
  smtpEncryptionKeyPrevious: env.SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS,
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
  api: z
    .preprocess(
      normalizeProvider,
      z.object({ ...commonFields, ...serverFields, ...apiOnlyFields }).and(apiProviderFields),
    )
    .superRefine(checkServerRules)
    .transform((env) => ({
      ...toCommon(env),
      ...toServer(env),
      mailApiProvider: toApiProvider(env),
      port: env.PORT,
      allowedFromDomains: env.ALLOWED_FROM_DOMAINS,
      apiKeyPepper: env.API_KEY_PEPPER,
      rateLimitDefaultPerMinute: env.RATE_LIMIT_DEFAULT_PER_MINUTE,
      maxBodyBytes: env.MAX_BODY_BYTES,
      maxAttachmentsBytes: env.MAX_ATTACHMENTS_BYTES,
    })),
  worker: z
    .preprocess(
      normalizeProvider,
      z.object({ ...commonFields, ...serverFields, ...workerOnlyFields }).and(workerProviderFields),
    )
    .superRefine(checkServerRules)
    .superRefine(checkWorkerRules)
    .transform((env) => ({
      ...toCommon(env),
      ...toServer(env),
      mailApiProvider: toWorkerProvider(env),
      worker: {
        queues: env.WORKER_QUEUES,
        healthPort: env.WORKER_HEALTH_PORT,
        apiConcurrency: env.WORKER_API_CONCURRENCY,
        apiRateLimitPerSecond: env.WORKER_API_RATE_LIMIT_PER_SECOND,
        smtpConcurrency: env.WORKER_SMTP_CONCURRENCY,
        maxAttempts: env.WORKER_MAX_ATTEMPTS,
        backoffBaseMs: env.WORKER_BACKOFF_BASE_MS,
      },
      maintenance: {
        sweepIntervalMs: env.SWEEP_INTERVAL_MS,
        stalePendingAfterMs: env.STALE_PENDING_AFTER_MS,
        pendingMaxAgeMs: env.PENDING_MAX_AGE_MS,
        payloadRetentionDays: env.PAYLOAD_RETENTION_DAYS,
        eventsRetentionDays: env.EVENTS_RETENTION_DAYS,
        messageRetentionDays: env.MESSAGE_RETENTION_DAYS,
      },
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
