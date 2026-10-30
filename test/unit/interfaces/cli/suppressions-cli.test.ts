import { describe, expect, it } from 'vitest';
import { InMemorySuppressionRepository } from '../../../../src/infrastructure/db/in-memory/in-memory-suppression-repository';
import { runSuppressionsCli } from '../../../../src/interfaces/cli/suppressions-cli';
import { FakeClock } from '../../../support/fake-clock';

function setup() {
  const clock = new FakeClock();
  const suppressions = new InMemorySuppressionRepository(clock);
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSuppressionsCli(argv, suppressions, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { clock, suppressions, run };
}

describe('suppressions CLI', () => {
  it('adds an address in lowercase with reason manual and source cli', async () => {
    const { run, suppressions, clock } = setup();

    const result = await run('add', '--email', 'Cliente@Dominio.com');

    expect(result).toEqual({ code: 0, out: 'cliente@dominio.com suppressed', err: '' });
    expect(await suppressions.list()).toEqual([
      { email: 'cliente@dominio.com', reason: 'manual', source: 'cli', createdAt: clock.now() },
    ]);
  });

  it('removes an address regardless of case', async () => {
    const { run, suppressions } = setup();
    await suppressions.add('cliente@dominio.com', 'bounce', 'mailgun');

    const result = await run('remove', '--email', 'CLIENTE@dominio.com');

    expect(result).toEqual({
      code: 0,
      out: 'cliente@dominio.com is no longer suppressed',
      err: '',
    });
    expect(await suppressions.list()).toEqual([]);
  });

  it('lists address, reason, source and date, oldest first', async () => {
    const { run, suppressions, clock } = setup();
    await suppressions.add('rebote@dominio.com', 'bounce', 'ses');
    clock.advance(60_000);
    await suppressions.add('manual@dominio.com', 'manual', 'cli');

    const result = await run('list');

    expect(result).toEqual({
      code: 0,
      out: [
        'rebote@dominio.com\tbounce\tses\t2026-10-29T10:00:00.000Z',
        'manual@dominio.com\tmanual\tcli\t2026-10-29T10:01:00.000Z',
      ].join('\n'),
      err: '',
    });
  });

  it('filters the list by reason', async () => {
    const { run, suppressions } = setup();
    await suppressions.add('rebote@dominio.com', 'bounce', 'ses');
    await suppressions.add('queja@dominio.com', 'complaint', 'ses');

    const result = await run('list', '--reason', 'complaint');

    expect(result.out).toBe('queja@dominio.com\tcomplaint\tses\t2026-10-29T10:00:00.000Z');
  });

  it.each([
    ['no command', [], 'Expected exactly one command'],
    ['an unknown command', ['purge'], 'Unknown command: purge'],
    ['add without --email', ['add'], 'Missing --email'],
    ['an invalid email', ['add', '--email', 'not-an-email'], '--email must be an email address'],
    ['remove without --email', ['remove'], 'Missing --email'],
    [
      'an unknown reason',
      ['list', '--reason', 'spam'],
      '--reason accepts bounce, complaint, unsubscribe and manual',
    ],
    ['an unknown option', ['list', '--all'], "Unknown option '--all'"],
  ])('prints the usage and exits with 2 on %s', async (_case, argv, message) => {
    const { run, suppressions } = setup();

    const result = await run(...argv);

    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(result.err).toContain('Usage: suppressions <command>');
    expect(await suppressions.list()).toEqual([]);
  });
});
