import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import { generateOpenApiYaml } from '../../src/interfaces/http/openapi-document';

// Devuelve los problemas encontrados en el fichero; vacío si está al día y es válido
export async function checkOpenApiFile(path: string, version: string): Promise<string[]> {
  let current: string;
  try {
    current = await readFile(path, 'utf8');
  } catch {
    return ['openapi.yaml does not exist: run bun run openapi:export'];
  }

  if (current !== (await generateOpenApiYaml(version))) {
    return ['openapi.yaml is out of date: run bun run openapi:export'];
  }

  try {
    await SwaggerParser.validate(path);
    return [];
  } catch (error) {
    return [`openapi.yaml is not a valid OpenAPI document: ${(error as Error).message}`];
  }
}
