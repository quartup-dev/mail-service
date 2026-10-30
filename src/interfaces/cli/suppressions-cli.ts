import { z } from 'zod';
import type {
  SuppressionEntry,
  SuppressionReason,
  SuppressionRepository,
} from '../../application/ports/suppression-repository';
import { type CliOutput, EXIT_OK, EXIT_USAGE, parseCommandLine, UsageError } from './cli-support';

const USAGE = `Usage: suppressions <command> [options]

  list [--reason bounce|complaint|unsubscribe|manual]
  add --email <address>       (reason manual)
  remove --email <address>`;

const OPTIONS = {
  email: { type: 'string' },
  reason: { type: 'string' },
} as const;

type Options = Partial<Record<keyof typeof OPTIONS, string>>;

const REASONS: readonly SuppressionReason[] = ['bounce', 'complaint', 'unsubscribe', 'manual'];

export async function runSuppressionsCli(
  argv: string[],
  suppressions: SuppressionRepository,
  output: CliOutput,
): Promise<number> {
  try {
    const { command, options } = parseCommandLine(argv, OPTIONS);
    await runCommand(command, options, suppressions, output);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    output.err(`${error.message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
}

async function runCommand(
  command: string,
  options: Options,
  suppressions: SuppressionRepository,
  output: CliOutput,
): Promise<void> {
  switch (command) {
    case 'add': {
      const email = emailOf(options);
      await suppressions.add(email, 'manual', 'cli');
      output.out(`${email} suppressed`);
      return;
    }
    case 'remove': {
      const email = emailOf(options);
      await suppressions.remove(email);
      output.out(`${email} is no longer suppressed`);
      return;
    }
    case 'list': {
      const reason = reasonOf(options);
      const entries = await suppressions.list(reason ? { reason } : {});
      for (const entry of entries) output.out(describe(entry));
      return;
    }
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}

function emailOf(options: Options): string {
  if (!options.email) throw new UsageError('Missing --email');
  if (!z.email().safeParse(options.email).success) {
    throw new UsageError('--email must be an email address');
  }
  return options.email.toLowerCase();
}

function reasonOf(options: Options): SuppressionReason | undefined {
  if (options.reason === undefined) return undefined;
  const reason = REASONS.find((candidate) => candidate === options.reason);
  if (!reason) throw new UsageError('--reason accepts bounce, complaint, unsubscribe and manual');
  return reason;
}

function describe(entry: SuppressionEntry): string {
  return [entry.email, entry.reason, entry.source, entry.createdAt.toISOString()].join('\t');
}
