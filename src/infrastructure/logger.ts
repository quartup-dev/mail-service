import { pino, type DestinationStream, type Level, type Logger } from 'pino';

export interface LoggerOptions {
  level: Level | 'silent';
}

// Campos sensibles, en la raíz y un nivel por debajo (p. ej. transport.smtp.auth.pass)
const SENSITIVE_PATHS = [
  'smtp.auth.pass',
  'dkim.privateKey',
  'apiKey',
  'smtpConfigEncrypted',
  'authorization',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  ...SENSITIVE_PATHS,
  ...SENSITIVE_PATHS.map((path) => `*.${path}`),
];

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const pinoOptions = { level: options.level, redact: REDACT_PATHS };
  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}
