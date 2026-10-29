import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPIV3_1 } from 'openapi-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ERROR_CODES } from '../../../../src/interfaces/http/api-error';
import {
  buildOpenApiApp,
  generateOpenApiYaml,
} from '../../../../src/interfaces/http/openapi-document';

type Document = OpenAPIV3_1.Document;
type Schema = OpenAPIV3_1.SchemaObject & { $ref?: string };

const EXPECTED_RESPONSES: Record<string, Record<string, string[]>> = {
  '/v1/emails': { post: ['200', '202', '400', '401', '403', '409', '413', '422', '429', '500'] },
  '/v1/emails/{id}': { get: ['200', '400', '401', '404', '429', '500'] },
  '/health': { get: ['200'] },
  '/ready': { get: ['200', '503'] },
};

describe('OpenAPI document', () => {
  let app: FastifyInstance;
  let document: Document;

  beforeAll(async () => {
    app = buildOpenApiApp('1.2.3');
    await app.ready();
    document = app.swagger() as Document;
  });

  afterAll(async () => {
    await app.close();
  });

  const schemas = () => document.components?.schemas ?? {};
  const resolve = (schema: Schema): Schema =>
    schema.$ref ? (schemas()[schema.$ref.replace('#/components/schemas/', '')] as Schema) : schema;

  it('is OpenAPI 3.1 with the given version and passes the validator', async () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.version).toBe('1.2.3');
    await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined();
  });

  it('declares a response for every status code of each route', () => {
    const declared = Object.fromEntries(
      Object.entries(document.paths ?? {}).map(([path, item]) => [
        path,
        Object.fromEntries(
          Object.entries(item ?? {}).map(([method, operation]) => [
            method,
            Object.keys((operation as OpenAPIV3_1.OperationObject).responses ?? {}).sort(),
          ]),
        ),
      ]),
    );

    expect(declared).toEqual(EXPECTED_RESPONSES);
  });

  it('describes every response', () => {
    const descriptions = Object.values(document.paths ?? {}).flatMap((item) =>
      Object.values(item ?? {}).flatMap((operation) =>
        Object.values((operation as OpenAPIV3_1.OperationObject).responses ?? {}).map(
          (response) => (response as OpenAPIV3_1.ResponseObject).description,
        ),
      ),
    );

    expect(descriptions).not.toContain('Default Response');
  });

  it('does not expose the documentation routes', () => {
    expect(Object.keys(document.paths ?? {}).some((path) => path.startsWith('/docs'))).toBe(false);
  });

  it('declares the named schemas as components, without input/output suffixes', () => {
    expect(Object.keys(schemas()).sort()).toEqual(
      [
        'Address',
        'ApiTransport',
        'Attachment',
        'AttemptOutcome',
        'DeliverySummary',
        'EmailAccepted',
        'EmailAttempt',
        'EmailRecipientStatus',
        'EmailRequest',
        'EmailStatus',
        'EmailStatusResponse',
        'ErrorCode',
        'ErrorResponse',
        'HealthResponse',
        'ProviderName',
        'ReadyResponse',
        'RecipientKind',
        'RecipientStatus',
        'SmtpServer',
        'SmtpTransport',
        'TransportType',
        'ValidationIssue',
      ].sort(),
    );
  });

  it('only declares components that some route uses', () => {
    const text = JSON.stringify(document.paths);
    const referenced = new Set<string>();
    const pending = [...text.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1] ?? '');
    while (pending.length > 0) {
      const name = pending.pop() ?? '';
      if (referenced.has(name)) continue;
      referenced.add(name);
      const nested = JSON.stringify(schemas()[name]);
      pending.push(
        ...[...nested.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1] ?? ''),
      );
    }

    expect(Object.keys(schemas()).filter((name) => !referenced.has(name))).toEqual([]);
  });

  it('declares ErrorResponse.code as an enum of every error code', () => {
    const error = resolve(schemas().ErrorResponse as Schema).properties?.error as Schema;
    const code = resolve(error.properties?.code as Schema);

    expect(code.enum).toEqual([...ERROR_CODES]);
  });

  it('has no response schema without properties', () => {
    const visited = new Set<Schema>();
    const objectsWithoutProperties: string[] = [];
    const walk = (schema: Schema | undefined, where: string) => {
      if (!schema) return;
      const resolved = resolve(schema);
      if (visited.has(resolved)) return;
      visited.add(resolved);
      if (resolved.type === 'object' && Object.keys(resolved.properties ?? {}).length === 0) {
        objectsWithoutProperties.push(where);
      }
      for (const [name, child] of Object.entries(resolved.properties ?? {})) {
        walk(child, `${where}.${name}`);
      }
      if (resolved.type === 'array') walk(resolved.items, `${where}[]`);
      for (const option of [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? [])]) {
        walk(option, where);
      }
    };
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        for (const [status, response] of Object.entries(
          (operation as OpenAPIV3_1.OperationObject).responses ?? {},
        )) {
          const content = (response as OpenAPIV3_1.ResponseObject).content?.['application/json'];
          walk(content?.schema, `${method} ${path} ${status}`);
        }
      }
    }

    expect(objectsWithoutProperties).toEqual([]);
  });

  it('protects /v1/emails routes with a bearer API key', () => {
    expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.paths?.['/v1/emails']?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths?.['/v1/emails/{id}']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths?.['/health']?.get?.security).toBeUndefined();
  });

  it('documents X-Request-Id, Idempotency-Key and Retry-After', () => {
    const post = document.paths?.['/v1/emails']?.post;
    const parameters = (post?.parameters ?? []) as OpenAPIV3_1.ParameterObject[];
    const responses = post?.responses as Record<string, OpenAPIV3_1.ResponseObject>;

    expect(parameters.map((parameter) => `${parameter.in}:${parameter.name}`)).toEqual(
      expect.arrayContaining(['header:idempotency-key', 'header:x-request-id']) as unknown,
    );
    for (const response of Object.values(responses)) {
      expect(Object.keys(response.headers ?? {})).toContain('X-Request-Id');
    }
    expect(responses['429']?.headers?.['Retry-After']).toMatchObject({
      schema: { type: 'integer' },
    });
    expect(responses['202']?.headers?.['X-Request-Id']).toMatchObject({
      schema: { type: 'string' },
    });
  });

  it('includes examples for both transports and for the status response', () => {
    const request = schemas().EmailRequest as Schema & { examples?: unknown[] };
    const status = schemas().EmailStatusResponse as Schema & { examples?: unknown[] };

    expect(request.examples).toHaveLength(2);
    expect(status.examples).toHaveLength(1);
  });

  it('generates the same YAML every time', async () => {
    const first = await generateOpenApiYaml('1.2.3');

    expect(first).toContain('openapi: 3.1.0');
    // Sin anclas ni alias de YAML: más fácil de leer y de comparar
    expect(first).not.toMatch(/[&*]a\d+/);
    expect(await generateOpenApiYaml('1.2.3')).toBe(first);
  });

  it('serves the documentation at /docs', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(response.statusCode).toBe(200);
    expect(response.json<Document>().info.title).toBe('mail-service');
  });
});
