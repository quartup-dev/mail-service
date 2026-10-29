import { parseArgs } from 'node:util';
import type { TransportType } from '../../domain/email';
import {
  ApiClientAdminError,
  type ClientSettings,
  type ClientSummary,
  type DrizzleApiClientAdmin,
} from '../../infrastructure/auth/drizzle-api-client-admin';

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: keys <command> [options]

  client:create --id <id> --name <name> [--transports smtp,api] [--from-domains a.com,*.b.com] [--rate-limit <n>]
  client:update --id <id> [--name <name>] [--transports ...] [--from-domains ...] [--rate-limit <n>]
  client:disable --id <id>
  client:enable --id <id>
  key:create --client <id> [--expires-at YYYY-MM-DD]
  key:revoke --client <id> --key-id <keyId>
  list`;

const OPTIONS = {
  id: { type: 'string' },
  name: { type: 'string' },
  transports: { type: 'string' },
  'from-domains': { type: 'string' },
  'rate-limit': { type: 'string' },
  client: { type: 'string' },
  'expires-at': { type: 'string' },
  'key-id': { type: 'string' },
} as const;

type Options = Partial<Record<keyof typeof OPTIONS, string>>;

// Argumentos inválidos: se informa del uso antes de tocar la base de datos
class UsageError extends Error {}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

export async function runKeysCli(
  argv: string[],
  admin: DrizzleApiClientAdmin,
  output: CliOutput,
): Promise<number> {
  try {
    const { command, options } = parseCommandLine(argv);
    await runCommand(command, options, admin, output);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      output.err(`${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (error instanceof ApiClientAdminError) {
      output.err(error.message);
      return EXIT_FAILURE;
    }
    throw error;
  }
}

function parseCommandLine(argv: string[]): { command: string; options: Options } {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
    const [command] = positionals;
    if (!command || positionals.length > 1) throw new UsageError('Expected exactly one command');
    return { command, options: values };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function runCommand(
  command: string,
  options: Options,
  admin: DrizzleApiClientAdmin,
  output: CliOutput,
): Promise<void> {
  switch (command) {
    case 'client:create': {
      const id = required(options, 'id');
      await admin.createClient(id, {
        name: required(options, 'name'),
        allowedTransports: transportsOf(options) ?? ['smtp', 'api'],
        allowedFromDomains: listOf(options['from-domains']) ?? null,
        rateLimitPerMinute: rateLimitOf(options) ?? null,
      });
      output.out(`Client ${id} created`);
      return;
    }
    case 'client:update': {
      const id = required(options, 'id');
      await admin.updateClient(id, settingsPatchOf(options));
      output.out(`Client ${id} updated`);
      return;
    }
    case 'client:disable':
    case 'client:enable': {
      const id = required(options, 'id');
      await admin.setClientStatus(id, command === 'client:disable' ? 'disabled' : 'active');
      output.out(`Client ${id} ${command === 'client:disable' ? 'disabled' : 'enabled'}`);
      return;
    }
    case 'key:create': {
      const clientId = required(options, 'client');
      const expiresAt = dateOf(options['expires-at']);
      const { keyId, key } = await admin.createKey(clientId, expiresAt ? { expiresAt } : {});
      output.out(`Key ${keyId} created for client ${clientId}.`);
      output.out('Store it now: it will not be shown again.');
      output.out(key);
      return;
    }
    case 'key:revoke': {
      const clientId = required(options, 'client');
      const keyId = required(options, 'key-id');
      await admin.revokeKey(clientId, keyId);
      output.out(`Key ${keyId} of client ${clientId} revoked`);
      return;
    }
    case 'list':
      for (const client of await admin.list()) output.out(describeClient(client));
      return;
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

function required(options: Options, name: keyof Options): string {
  const value = options[name];
  if (!value) throw new UsageError(`Missing --${name}`);
  return value;
}

function listOf(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isTransport(value: string): value is TransportType {
  return value === 'smtp' || value === 'api';
}

function transportsOf(options: Options): TransportType[] | undefined {
  const transports = listOf(options.transports);
  if (!transports) return undefined;
  if (transports.length === 0 || !transports.every(isTransport)) {
    throw new UsageError('--transports accepts smtp and api');
  }
  return transports;
}

function rateLimitOf(options: Options): number | undefined {
  const value = options['rate-limit'];
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new UsageError('--rate-limit must be a positive integer');
  }
  return limit;
}

function dateOf(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) {
    throw new UsageError('--expires-at must be a date like 2027-10-29');
  }
  return date;
}

function settingsPatchOf(options: Options): Partial<ClientSettings> {
  const transports = transportsOf(options);
  const fromDomains = listOf(options['from-domains']);
  const rateLimit = rateLimitOf(options);
  return {
    ...(options.name !== undefined && { name: options.name }),
    ...(transports && { allowedTransports: transports }),
    ...(fromDomains && { allowedFromDomains: fromDomains }),
    ...(rateLimit !== undefined && { rateLimitPerMinute: rateLimit }),
  };
}

function describeClient(client: ClientSummary): string {
  const lines = [
    `${client.id} (${client.status}) ${client.name}`,
    `  transports: ${client.allowedTransports.join(', ')}`,
    `  from domains: ${client.allowedFromDomains?.join(', ') ?? '(global ALLOWED_FROM_DOMAINS)'}`,
    `  rate limit: ${client.rateLimitPerMinute ?? '(default)'} per minute`,
    ...client.keys.map(
      (key) =>
        `  key ${key.keyId}: ${key.status}, created ${key.createdAt.toISOString()}` +
        (key.expiresAt ? `, expires ${key.expiresAt.toISOString()}` : '') +
        (key.revokedAt ? `, revoked ${key.revokedAt.toISOString()}` : ''),
    ),
  ];
  return lines.join('\n');
}
