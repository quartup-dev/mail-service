import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateOpenApiYaml } from '../../../src/interfaces/http/openapi-document';
import { checkOpenApiFile } from '../../../scripts/lib/openapi-check';

describe('checkOpenApiFile', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'openapi-check-'));
    path = join(directory, 'openapi.yaml');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes with an up-to-date file', async () => {
    await writeFile(path, await generateOpenApiYaml('1.0.0'));

    expect(await checkOpenApiFile(path, '1.0.0')).toEqual([]);
  });

  it('fails when the routes changed and the file was not regenerated', async () => {
    const stale = (await generateOpenApiYaml('1.0.0')).replace(
      'Solicita el envío de un correo',
      'Texto antiguo',
    );
    await writeFile(path, stale);

    expect(await checkOpenApiFile(path, '1.0.0')).toEqual([
      'openapi.yaml is out of date: run bun run openapi:export',
    ]);
  });

  it('fails when the file does not exist', async () => {
    expect(await checkOpenApiFile(path, '1.0.0')).toEqual([
      'openapi.yaml does not exist: run bun run openapi:export',
    ]);
  });
});
