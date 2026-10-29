import fastifySwagger, {
  type SwaggerTransform,
  type SwaggerTransformObject,
} from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import type { OpenAPIV3_1 } from 'openapi-types';

type Document = OpenAPIV3_1.Document;

type ResponseHeaders = Record<string, { type: string; description: string }>;

// Objetos nuevos en cada respuesta: un objeto compartido aparecería como ancla y alias en el YAML
const responseHeaders = (status: string): ResponseHeaders => ({
  'X-Request-Id': {
    type: 'string',
    description: 'Identificador de la petición (el recibido o uno generado)',
  },
  ...(status === '429' && {
    'Retry-After': {
      type: 'integer',
      description: 'Segundos que hay que esperar antes de reintentar',
    },
  }),
});

// jsonSchemaTransform descarta las cabeceras de respuesta: se añaden aquí a todas las rutas
const transform: SwaggerTransform = (route) => {
  const transformed = jsonSchemaTransform(route);
  const responses = (transformed.schema as { response?: Record<string, { headers?: unknown }> })
    ?.response;
  for (const [status, response] of Object.entries(responses ?? {})) {
    response.headers = responseHeaders(status);
  }
  return transformed;
};

const SCHEMA_REF = /#\/components\/schemas\/([\w-]+)/g;

// fastify-type-provider-zod emite cada esquema con nombre dos veces (entrada "XInput" y salida
// "X"), aunque solo se use en un sentido. Se quitan los que ninguna ruta usa y, si solo queda la
// variante de entrada, recupera su nombre: el contrato usa los nombres del dominio
const transformObject: SwaggerTransformObject = (input) => {
  const document = jsonSchemaTransformObject(input) as Document;
  const schemas = document.components?.schemas ?? {};
  const used = referencedSchemas(document.paths, schemas);

  const renames = new Map<string, string>();
  for (const name of used) {
    const base = name.replace(/Input$/, '');
    if (base !== name && !used.has(base)) renames.set(name, base);
  }

  const kept = Object.entries(schemas)
    .filter(([name]) => used.has(name))
    .map(([name, schema]) => [renames.get(name) ?? name, schema] as const);
  const renamed = JSON.parse(
    JSON.stringify({ paths: document.paths, schemas: Object.fromEntries(kept) }).replace(
      SCHEMA_REF,
      (ref, name: string) => `#/components/schemas/${renames.get(name) ?? name}`,
    ),
  ) as { paths: Document['paths']; schemas: Record<string, unknown> };

  return {
    ...document,
    paths: renamed.paths,
    components: { ...document.components, schemas: renamed.schemas },
  } as ReturnType<SwaggerTransformObject>;
};

// Esquemas referenciados desde las rutas, directa o indirectamente
function referencedSchemas(paths: unknown, schemas: Record<string, unknown>): Set<string> {
  const used = new Set<string>();
  const pending = refsIn(paths);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (used.has(name)) continue;
    used.add(name);
    pending.push(...refsIn(schemas[name]));
  }
  return used;
}

function refsIn(value: unknown): string[] {
  return [...JSON.stringify(value ?? null).matchAll(SCHEMA_REF)].map((match) => match[1] ?? '');
}

// Se registra en la instancia raíz y antes que las rutas: recoge sus esquemas con un hook onRoute
export function registerOpenApi(app: FastifyInstance, version: string): void {
  void app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'mail-service',
        description: 'Envío de correo por SMTP o por el proveedor de API configurado',
        version,
      },
      tags: [
        { name: 'emails', description: 'Envío y estado de mensajes' },
        { name: 'health', description: 'Estado del servicio' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description: 'API key con el formato ms_<clientId>_<secret>',
          },
        },
      },
    },
    transform,
    transformObject,
  });
  void app.register(fastifySwaggerUi, { routePrefix: '/docs' });
}
