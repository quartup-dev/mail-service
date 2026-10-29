import fastifySwagger, { type SwaggerTransform } from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

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
    transformObject: jsonSchemaTransformObject,
  });
  void app.register(fastifySwaggerUi, { routePrefix: '/docs' });
}
