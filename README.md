# mail-service

Microservicio de envío de correo por SMTP o por API (Mailgun, SES) para servicios internos.

> En construcción. El plan de implementación está en [docs/plans/plan-implementacion.md](docs/plans/plan-implementacion.md) y las reglas del proyecto en [.claude/CLAUDE.md](.claude/CLAUDE.md). Este README se completará en la fase 6.

## Requisitos

- Node.js 24 (`nvm use` lee `.nvmrc`).
- Bun, solo como gestor de paquetes y para lanzar scripts.
- Docker y Docker Compose.

## Puesta en marcha en local

```bash
bun install
bun run dev:certs           # CA local y certificado de Mailpit (solo la primera vez)
docker compose up -d --wait # PostgreSQL, Redis y Mailpit
cp .env.example .env        # y rellena API_KEY_PEPPER y SMTP_CREDENTIALS_ENCRYPTION_KEY
                            # con: openssl rand -base64 32
bun run db:migrate          # aplica las migraciones de drizzle/
bun run dev                 # API en http://localhost:3000
bun run dev:worker          # worker; health en http://localhost:3001
curl http://localhost:3000/health
curl http://localhost:3001/ready
```

Clientes y API keys (la key solo se muestra al crearla):

```bash
bun run keys client:create --id billing --name "Facturación" --transports api --from-domains example.com
bun run keys key:create --client billing [--expires-at 2027-10-29]
bun run keys key:revoke --client billing --key-id k_2026_10_a1b2c3
bun run keys list
```

La API se documenta en `http://localhost:3000/docs`. El contrato para los servicios consumidores es `openapi.yaml`, generado desde las rutas:

```bash
bun run openapi:export      # regenera openapi.yaml
bun run openapi:check       # falla si openapi.yaml no está al día o no es válido
```

Comprobaciones:

```bash
bun run lint
bun run typecheck
bun run test                # unitarios; nunca "bun test", que lanza el runner de Bun
bun run test:coverage       # unitarios con cobertura (mínimo 80 % en domain/ y application/)
bun run test:integration    # requiere docker compose up
```

Servicios de desarrollo:

| Servicio                            | Puerto en el host |
| ----------------------------------- | ----------------- |
| API (documentación en `/docs`)      | 3000              |
| PostgreSQL                          | 55432             |
| Redis                               | 56379             |
| Mailpit SMTP (STARTTLS obligatorio) | 587               |
| Mailpit web                         | 8025              |
| Health del worker                   | 3001              |

## Decisiones

Decisiones tomadas durante la implementación que no estaban fijadas en el plan:

- **TypeScript 6.0 en lugar de 7.** `typescript-eslint` todavía no soporta TypeScript 7 (admite `<6.1.0`), y lo necesitamos para el lint con información de tipos. Revisar cuando lo soporte.
- **Puertos 55432 y 56379 para PostgreSQL y Redis en desarrollo.** Los puertos estándar suelen estar ocupados por instancias locales.
- **Cuatro tipos de proceso en la configuración**: `api`, `worker`, `keys-cli` y `suppressions-cli`. Los dos CLIs necesitan variables distintas (solo el de keys necesita `API_KEY_PEPPER`), así que no comparten esquema.
- **`VAR=` equivale a no definir la variable.** Es lo habitual en los ficheros `.env`: una variable vacía usa su valor por defecto o, si es obligatoria, da error de configuración.
- **Claves de 32 bytes en base64 estricto.** `SMTP_CREDENTIALS_ENCRYPTION_KEY`, su clave anterior y `API_KEY_PEPPER` se rechazan si no son exactamente 32 bytes, y el error nunca muestra el valor.
- **Regla `@typescript-eslint/require-await` desactivada.** Fastify espera plugins y handlers `async` aunque no usen `await`.
- **La clave privada del certificado de Mailpit tiene permisos 644.** El contenedor de Mailpit tiene que poder leerla; es un certificado solo de desarrollo y está fuera del repositorio. La clave de la CA queda en 600.

### Fase 1: dominio y casos de uso

- **Dos puertos más que en el plan: `IdGenerator` y `Logger`.** `QueueEmail` genera el UUID v7 del mensaje a través de `IdGenerator`, para que los tests usen ids deterministas. `Logger` es el subconjunto de Pino que usan los casos de uso (`info`, `warn`, `error`), porque `application/` no puede importar Pino.
- **`updateStatus` recibe un _patch_ acotado (`EmailStatusPatch`)** en lugar de `Partial<StoredEmail>`: solo proveedor, `providerMessageId`, código y mensaje de error, `sentAt` y `smtpConfigEncrypted`.
- **El hash de la petición se calcula en `application/` con `node:crypto`.** Es un módulo de Node, no una librería de transporte. El hash es SHA-256 del cuerpo con la contraseña SMTP y la clave DKIM sustituidas por su HMAC-SHA256 con `API_KEY_PEPPER`.
- **El `payload` de un mensaje SMTP solo guarda `host` y `port`.** La configuración completa (credenciales y DKIM) se guarda como JSON cifrado con `SecretBox` en `smtpConfigEncrypted`.
- **Errores no clasificados en el worker.** Un error que no es `ProviderError` se trata como transitorio, con código `UNEXPECTED_ERROR`: un fallo puntual no previsto se reintenta. Si ocurre después de que el servidor acepte el correo, el reintento puede duplicarlo, coherente con la garantía "al menos una vez". Un `ProviderError` sin código se guarda como `PROVIDER_ERROR`.
- **Fallos de configuración SMTP en el worker.** Una clave de cifrado desconocida (`SMTP_CONFIG_UNDECRYPTABLE`) o un host que el guard ya no permite (`SMTP_HOST_NOT_ALLOWED`) se convierten en `PermanentProviderError` del proveedor `smtp`: dejan el mensaje en `failed`, registran el intento y se relanzan como cualquier error permanente.
- **`ProcessEmailJob` relanza siempre que el mensaje acaba en `failed` o vuelve a `queued`**, también con un error transitorio en el último intento. Así BullMQ registra el job como fallido y el consumidor no necesita casos especiales.
- **Transporte `api` sin proveedor en el worker.** Si un mensaje `api` llega a un worker sin `MAIL_API_PROVIDER`, queda en `failed` con `API_TRANSPORT_NOT_CONFIGURED`, sin intento registrado, y se lanza `EmailRequestRejectedError` con ese código (no hay proveedor que nombrar en un `PermanentProviderError`). El consumidor de la fase 2 lo trata como no reintentable.
- **Supresión desde eventos sin correlación.** Un rebote, queja o baja añade la dirección a la supresión aunque el evento no se correlacione con ningún mensaje (por ejemplo, porque la retención ya lo borró): la reputación de la cuenta del proveedor es la misma.
- **Hora del estado por destinatario.** Con eventos, `updatedAt` del destinatario es la hora del evento (`occurredAt`). Con el resultado del worker, es la hora en que se guarda.
- **Barrido.** La caducidad (`EXPIRED`) se repite por lotes hasta que no quedan mensajes. El re-encolado procesa un solo lote por barrido, porque encolar no cambia `updated_at`; el resto queda para el siguiente.
- **Retención de payloads por `updated_at`.** `clearPayloads` usa la fecha en que el mensaje pasó a estado final, que es su `updated_at`: los estados finales no cambian.
- **El host SMTP no se repite en `email_attempts`.** Ya está en `emails.smtp_host`, y el esquema de la fase 2 no tiene esa columna en los intentos.
- **Repositorios en memoria en `src/infrastructure/db/in-memory/`** y sus tests de contrato en `test/contracts/`, para reutilizarlos con Drizzle en la fase 2. Los fakes de proveedores, guard, cola, logger y reloj están en `test/support/`.

### Fase 2: persistencia, colas y worker

- **ioredis 5.11.1 en lugar de 6.** BullMQ 6 admite ioredis 6 como _peer_, pero sus tests usan la 5.11.1. Revisar al actualizar BullMQ.
- **BullMQ 6.3.15**, la última versión de la línea 6.3 con más de dos semanas al fijarla (las 6.4 y 6.5 tenían días).
- **Backoff exponencial con _jitter_ de 0,5.** La espera de cada reintento es `WORKER_BACKOFF_BASE_MS · 2^(n-1)`, recortada al azar hasta la mitad para que los reintentos no lleguen en bloque.
- **Columna `position` en `email_recipients`** para conservar el orden de `to`, `cc` y `bcc`; **sin `last_event_at`**, porque `updated_at` ya guarda la hora del evento.
- **Índices en `email_attempts.email_id` y `email_events.email_id`**, además de los del plan: los usan la carga de intentos y el borrado en cascada de la retención.
- **Fechas con precisión de milisegundos (`timestamp(3)`)** y siempre puestas por la aplicación con su `Clock`, nunca con `now()` de PostgreSQL.
- **Migraciones con un script propio (`scripts/migrate.ts`)** en lugar de `drizzle-kit migrate`, que es dependencia de desarrollo y no estará en la imagen. Usa un tipo de proceso `migrate` en la configuración que solo exige `DATABASE_URL`, y busca las migraciones en `drizzle/` relativo al directorio de trabajo.
- **El log de cada envío lo escribe `ProcessEmailJob`** (con `messageId`, `clientId`, `requestId`, `transport`, `provider` y `attempt`), que ya tiene esos datos, en lugar del consumidor de BullMQ.
- **El consumidor convierte en `UnrecoverableError` tanto `PermanentProviderError` como `EmailRequestRejectedError`.**
- **Jobs de mantenimiento**: se borran al completarse y se conservan los 100 últimos fallidos, para no acumular uno por barrido en Redis. Cada fallo de mantenimiento se registra en el log con nivel `error`.
- **Vulnerabilidad moderada de `esbuild` en dependencias de desarrollo** (`drizzle-kit`, `tsx`, `tsup`, `vite`): afecta al servidor de desarrollo de esbuild, que no usamos, y no llega a la imagen. Revisar en la fase 6 con `bun audit`.
- **Tamaño de lote de barrido y retención fijo en 1000** y retención cada hora, sin variables de entorno.
- **Adaptadores SMTP provisionales.** Hasta la fase 3 (`SmtpHostGuard` con DNS) y la 4 (envío con Nodemailer, Mailgun y SES), el worker usa un guard y un sender que fallan siempre con error permanente, y no tiene proveedor de API: un mensaje que llegue al worker acaba en `failed`. La API aún no crea mensajes, así que no afecta a ningún envío real.
- **Tests de integración**: un _global setup_ recrea la base `mail_test` y aplica las migraciones; cada test vacía las tablas y usa un prefijo de Redis propio. Los ficheros de integración se ejecutan en serie.

### Fase 3: API HTTP y autenticación

- **Esquemas de petición con sufijo `Input` en OpenAPI** (`EmailRequestInput`, `AddressInput`...). `fastify-type-provider-zod` emite cada esquema con nombre en dos variantes, entrada y salida; las respuestas usan los nombres sin sufijo (`EmailAccepted`, `ErrorResponse`...).
- **`/health` solo documenta el 200.** Responde siempre que el proceso esté vivo; el 503 es de `/ready`.
- **Cabeceras de petición en minúsculas en la especificación** (`idempotency-key`, `x-request-id`): Fastify exige nombres en minúsculas en los esquemas de cabeceras.
- **`X-Request-Id` recibido** se acepta si cumple `[A-Za-z0-9._:-]{8,128}`; si no, se genera un UUID.
- **Rate limit tolerante a fallos de Redis** (`skipOnError`): si Redis no responde, la petición pasa sin límite. Para 3-4 servicios internos es preferible a rechazar envíos. Las respuestas incluyen además las cabeceras `x-ratelimit-*` del plugin.
- **La API lee `WORKER_MAX_ATTEMPTS` y `WORKER_BACKOFF_BASE_MS`**: las opciones de reintento van en cada job y las fija quien encola, que casi siempre es la API.
- **Conexión a Redis de la API sin cola offline**: si Redis no responde, encolar falla enseguida, la petición responde `queued` y el barrido encola el mensaje después.
- **Límite de adjuntos comprobado en la ruta**, no en el esquema: así el esquema con nombre no depende de `MAX_ATTACHMENTS_BYTES` y la especificación generada es la misma en cualquier entorno.
- **Cabeceras reservadas**: `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Sender`, `Subject`, `Date`, `Message-ID`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`, `Content-Disposition`, `Return-Path`, `DKIM-Signature` y `X-Mail-Service-Id`, sin distinguir mayúsculas. Los nombres de cabecera solo admiten letras, dígitos y guiones.
- **Otros errores 4xx de Fastify** (JSON mal formado, tipo de contenido no admitido) se responden como 400 `VALIDATION_ERROR`.
- **`SmtpHostGuard`**: resuelve con `dns.lookup` (como el resto del sistema, incluye `/etc/hosts` y el DNS de Docker) y conecta a la primera dirección. En IPv6 solo admite unicast global (`2000::/3`), sin documentación, Teredo ni 6to4. `SMTP_ALLOWED_PRIVATE_HOSTS` compara nombres exactos sin distinguir mayúsculas.
- **Keys**: el `keyId` tiene el formato `k_<año>_<mes>_<6 hex>`. Las keys caducadas no cuentan para el máximo de dos activas. `client:create` admite por defecto ambos transportes.
- **La comprobación de `openapi.yaml` vive en `scripts/lib/`**, no en `src/`, porque usa el validador, que es dependencia de desarrollo. `ajv` y `ajv-formats` se añaden como dependencias de desarrollo para el test de contrato de las respuestas.
