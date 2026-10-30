import { parseArgs } from 'node:util';

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

// Argumentos inválidos: se informa del uso antes de tocar la base de datos
export class UsageError extends Error {}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

type StringOptions = Record<string, { type: 'string' }>;

// Un único comando posicional y opciones de texto; cualquier otra cosa es un error de uso
export function parseCommandLine<O extends StringOptions>(
  argv: string[],
  options: O,
): { command: string; options: Partial<Record<keyof O, string>> } {
  try {
    const { positionals, values } = parseArgs({ args: argv, options, allowPositionals: true });
    const [command] = positionals;
    if (!command || positionals.length > 1) throw new UsageError('Expected exactly one command');
    return { command, options: values };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
