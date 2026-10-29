# mail-service

Microservicio de envío de correo para 3-4 servicios internos. Una API HTTP recibe peticiones de envío, las guarda y las encola; un worker las envía por **SMTP** (servidor indicado en cada petición) o por el **proveedor de API** configurado (Mailgun o SES). El servicio registra el estado de envío de cada mensaje y el estado de entrega de cada destinatario a partir de los webhooks de los proveedores.

**Plan de implementación:** [docs/plans/plan-implementacion.md](../docs/plans/plan-implementacion.md). Contiene la especificación de cada pieza y los criterios de aceptación por fase. Antes de trabajar en una fase, lee su sección completa.

## Stack (decisiones cerradas)

No cambies nada de esta lista sin consultarlo antes.

- **TypeScript** en modo `strict` y **Node.js 24 LTS** como runtime en todos los entornos (desarrollo, tests y producción).
- **Bun** solo como gestor de paquetes (`bun install`, lockfile `bun.lock`) y lanzador de scripts (`bun run <script>`). **No** se usa como runtime: los scripts de `package.json` invocan `node`, `tsx`, `vitest` o `tsup`, que corren sobre Node.
- **Fastify 5** para la API, con `fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/swagger-ui` y `@fastify/rate-limit`.
- **Zod** para validar peticiones y configuración.
- **BullMQ + Redis** para las colas.
- **PostgreSQL + Drizzle ORM** para la persistencia, incluidos los clientes y sus API keys.
- **Nodemailer** para SMTP, **`mailgun.js`** para Mailgun y **`@aws-sdk/client-sesv2`** para SES.
- **Pino** para logs (JSON estructurado; es el logger de Fastify).
- **Vitest** para tests, **ESLint + Prettier**, **tsx** en desarrollo y **tsup** para el build.
- **Docker + Docker Compose**; Mailpit como servidor SMTP de desarrollo.
- Despliegue como **servidor tradicional**. Nada de serverless: no añadas código para Lambda, SQS ni DynamoDB.

## Arquitectura

API y worker son **procesos separados** que comparten la misma base de código. Capas:

1. `src/domain/`: tipos, reglas y servicios puros.
2. `src/application/`: casos de uso y puertos (interfaces). Solo dependen de `domain/` y de sus puertos.
3. `src/infrastructure/`: adaptadores concretos (PostgreSQL, BullMQ, proveedores, cifrado, DNS, configuración).
4. `src/interfaces/`: transporte (plugins y rutas de Fastify, consumidores de BullMQ).
5. `src/server.ts` y `src/worker.ts`: entrypoints finos que construyen el contenedor de dependencias.

Reglas de dependencia (una regla de ESLint lo verifica):
- `domain/` y `application/` **nunca** importan de `infrastructure/` ni de `interfaces/`, ni librerías de transporte (Fastify, BullMQ, Drizzle, Nodemailer, SDKs de proveedores).
- La traducción entre el mundo de las librerías y el dominio se hace en `interfaces/` o `infrastructure/`. Ejemplo: el caso de uso lanza `PermanentProviderError` y el consumidor de BullMQ lo convierte en `UnrecoverableError`.

```
src/
├─ domain/            # email.ts, errors.ts, events.ts
├─ application/
│  ├─ ports/          # un fichero por puerto
│  └─ *.ts            # un fichero por caso de uso
├─ infrastructure/
│  ├─ config.ts       # única lectura de process.env
│  ├─ logger.ts
│  ├─ container.ts
│  ├─ auth/  crypto/  net/  providers/  queue/
│  └─ db/             # schema.ts, repositorios y in-memory/ para tests
├─ interfaces/
│  ├─ http/           # app.ts (buildApp, sin listen), plugins/, routes/, schemas/
│  └─ worker/         # consumidores y health-server.ts
├─ server.ts
└─ worker.ts
scripts/              # CLIs (keys.ts, suppressions.ts), export-openapi.ts y dev-certs.sh
test/unit/  test/integration/
openapi.yaml          # generado con bun run openapi:export; no editar a mano
```

## Comandos

```bash
bun install
bun run dev                 # API con tsx en modo watch
bun run dev:worker          # worker con tsx en modo watch
bun run build               # tsup: src/ y scripts/ a dist/
bun run lint
bun run typecheck
bun run test                # unitarios (Vitest); bun run test -- <fichero> para uno solo
bun run test:watch          # Vitest en modo watch, para el ciclo TDD
bun run test:integration    # requiere docker compose up (postgres, redis, mailpit)
bun run db:generate         # genera migración Drizzle
bun run db:migrate
bun run openapi:export      # regenera openapi.yaml a partir de las rutas
bun run openapi:check       # falla si openapi.yaml no está al día
bun run keys <comando>          # CLI de clientes y API keys
bun run suppressions <comando>  # CLI de la lista de supresión
bun run dev:certs           # CA local y certificado de Mailpit
```

Usa siempre `bun run test`, **nunca** `bun test`: este último lanza el test runner propio de Bun en lugar de Vitest. Para el resto de scripts, `bun <script>` equivale a `bun run <script>`.

En Docker Compose, los CLIs se ejecutan con `docker compose run --rm tools node dist/scripts/<cli>.js <comando>`.

## Convenciones

- Nombres de código en inglés. README y documentación en español.
- Sin `any` implícito. Errores tipados; cada adaptador de proveedor clasifica sus errores en `TransientProviderError` o `PermanentProviderError`.
- La configuración solo se lee en `infrastructure/config.ts`, validada con Zod y con un esquema por proceso (`api`, `worker`, `cli`). El resto del código la recibe ya validada.
- Clientes de SDK, pools y conexiones se crean una vez en el contenedor, nunca por petición o por envío.
- **Contrato OpenAPI**: cada ruta declara con Zod el esquema de la petición y el de **todas** sus respuestas posibles, éxito y error, con esquemas detallados y con nombre. Nada de `z.any()`, `z.unknown()` ni objetos genéricos en las respuestas. `openapi.yaml` se genera desde las rutas con `bun run openapi:export`, se versiona en el repositorio y nunca se edita a mano. Si cambias una ruta o un esquema, regenéralo en el mismo commit.
- Funciones pequeñas y nombres descriptivos.

## Invariantes de seguridad

Se cumplen siempre, en cualquier fase:

- **Logs**: nunca registrar cuerpos de mensaje, adjuntos, API keys, contraseñas SMTP ni claves DKIM. Pino redacta `*.smtp.auth.pass`, `*.dkim.privateKey`, `authorization` y equivalentes. Las direcciones de correo, solo en nivel `debug`.
- **TLS**: la verificación de certificados SMTP está siempre activa. No existe ninguna opción ni variable para desactivarla. En desarrollo, Mailpit usa un certificado de una CA local que se carga con `NODE_EXTRA_CA_CERTS`.
- **SSRF**: todo host SMTP pasa por `SmtpHostGuard` en la API y otra vez en el worker justo antes de enviar, y la conexión se hace a la IP validada.
- **Credenciales SMTP**: se cifran con `SecretBox` antes de persistir, nunca van en el job de la cola ni en el `payload`, y se borran cuando el mensaje llega a un estado final.
- **API keys**: solo se guardan hashes HMAC; el *pepper* vive en una variable de entorno. Comparaciones de keys y firmas en tiempo constante.
- **Webhooks**: siempre con verificación de firma y protección contra repeticiones. Son las únicas rutas expuestas a internet.
- **Cabeceras**: rechazar saltos de línea en asunto, nombres y cabeceras personalizadas; bloquear las cabeceras reservadas.
- Nunca credenciales reales en código, tests ni ejemplos.

## Método de trabajo: TDD

Todo el código de producción se escribe con TDD. **No escribas código de producción sin un test que falle y lo exija**, tampoco "porque el cambio es trivial".

### El ciclo

1. **Lista de casos.** Antes de empezar una tarea, escribe la lista de comportamientos a probar (camino feliz, casos límite, errores). El punto de partida son los criterios de aceptación de la fase en el plan. Añade la lista al plan, bajo la fase, como casillas en "Casos de prueba", y márcalas a medida que pasen.
2. **Rojo.** Escribe **un** test para el siguiente comportamiento más pequeño. Ejecútalo y comprueba que falla **por el motivo esperado**, con un mensaje útil, no por un error de compilación o de importación.
3. **Verde.** Escribe el código mínimo para que pase. Nada de lógica especulativa ni de "ya que estoy".
4. **Refactor.** Limpia nombres, duplicación y estructura con todos los tests en verde. Nunca cambies comportamiento en este paso. Generaliza solo cuando un segundo caso lo exija.
5. **Commit** en cada verde o en cada refactor que deje los tests en verde. Cada commit es una unidad revisable.

Ejecuta los tests en cada rojo y en cada verde: `bun run test -- <fichero>` para el ciclo corto, `bun run test:watch` mientras trabajas, y `bun run test` completo antes de cada commit.

### Qué test escribir según la capa

- **`domain/` y `application/`**: tests unitarios con los adaptadores en memoria y los fakes (`FakeApiProvider`, `FakeSmtpSender`, `FakeSmtpHostGuard`). Sin red, sin contenedores, en milisegundos. Es donde vive la mayor parte de los ciclos.
- **Rutas HTTP**: tests con `app.inject()` y dependencias falsas, escritos antes que la ruta. El primer rojo suele ser un 404.
- **Adaptadores de infraestructura** (repositorios Drizzle, BullMQ): tests de integración contra Docker Compose, escritos antes que el adaptador. Si el adaptador implementa un puerto, reutiliza la misma batería de tests que su versión en memoria (tests de contrato del puerto), así ambas se comportan igual.
- **Adaptadores de proveedores** (Mailgun, SES, Nodemailer): el test simula el cliente de la librería en la frontera y comprueba el mapeo del mensaje y la clasificación de errores.
- **Bugs**: primero un test que reproduzca el fallo (rojo); después el arreglo.

### Reglas para los tests

- Un comportamiento por test. El nombre se lee como una frase: `rejects an SMTP host that resolves to a private IP`.
- Prueba comportamiento, no estructura. Solo se sustituyen **puertos** (nuestras interfaces) por fakes; nunca se mockean funciones internas ni se verifica el orden de llamadas privadas.
- No se mockean librerías ajenas fuera de los adaptadores que las envuelven.
- Sin casos especulativos que ningún llamador ejercita.
- Los tests no dependen del orden de ejecución ni del reloj real: inyecta un reloj (`Clock`) donde haya fechas (barrido, retención, caducidad de keys).

### Excepciones

El ciclo rojo-verde no aplica a lo que no tiene comportamiento propio que probar antes: configuración de herramientas (ESLint, tsup, Vitest), `Dockerfile`, `docker-compose.yml`, migraciones generadas por Drizzle y `openapi.yaml` generado. Para estas piezas, la verificación es el criterio de aceptación correspondiente del plan. `config.ts` **sí** se hace con TDD: sus validaciones son comportamiento.

## Forma de trabajar

1. Trabaja por fases, en orden. No empieces una fase sin cumplir los criterios de aceptación de la anterior.
2. Antes de usar una librería, consulta su documentación vigente y fija versiones exactas en `package.json`. No asumas firmas de API de memoria.
3. Si encuentras un motivo técnico de peso para desviarte del stack o del plan, detente y explica la alternativa antes de aplicarla.
4. Si algo es ambiguo, elige la opción más simple que cumpla los criterios de aceptación y anótala en la sección "Decisiones" del README.
5. Al terminar una fase: ejecuta `bun run lint`, `bun run typecheck`, los tests y, a partir de la fase 3, `bun run openapi:check`. Después marca la fase como completada en el plan y resume qué se hizo, qué queda pendiente y qué decisiones se tomaron.
