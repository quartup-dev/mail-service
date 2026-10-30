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

Lista de supresión global (solo afecta al transporte `api`; los rebotes permanentes, quejas y bajas llegan solos por los webhooks):

```bash
bun run suppressions list [--reason bounce|complaint|unsubscribe|manual]
bun run suppressions add --email cliente@dominio.com      # motivo manual
bun run suppressions remove --email cliente@dominio.com   # vuelve a permitir envíos por api
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

## Probar los envíos

### SMTP contra Mailpit

El worker verifica siempre el certificado del servidor SMTP. Para confiar en la CA local de Mailpit, arráncalo con `NODE_EXTRA_CA_CERTS`, que Node solo lee al arrancar. `SMTP_ALLOWED_PRIVATE_HOSTS=mailpit,localhost` (valor de `.env.example`) permite usar Mailpit aunque resuelva a una IP privada.

```bash
NODE_EXTRA_CA_CERTS=./docker/dev-certs/ca.pem bun run dev:worker

curl -X POST http://localhost:3000/v1/emails \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "transport": { "type": "smtp", "smtp": { "host": "localhost", "port": 587,
      "auth": { "user": "prueba", "pass": "cualquiera" } } },
    "from": { "email": "notificaciones@example.com" },
    "to": [{ "email": "cliente@dominio.com" }],
    "subject": "Prueba", "text": "Hola"
  }'
```

El correo aparece en http://localhost:8025 y `GET /v1/emails/<id>` pasa a `sent`. El cliente necesita el transporte `smtp` y el dominio `example.com` permitidos (`bun run keys client:create ... --transports smtp,api --from-domains example.com`).

### Mailgun y SES con credenciales reales

Los adaptadores de Mailgun y SES se prueban con tests unitarios que simulan el cliente de cada librería. Contra el proveedor real se prueban a mano con una cuenta de pruebas: el dominio del remitente tiene que estar verificado en el proveedor, y en las cuentas _sandbox_ también los destinatarios.

**Mailgun.** En `.env`:

```dotenv
MAIL_API_PROVIDER=mailgun
MAILGUN_API_KEY=...            # clave de envío del dominio
MAILGUN_DOMAIN=mg.example.com
MAILGUN_REGION=eu              # o us, según dónde esté el dominio
MAILGUN_WEBHOOK_SIGNING_KEY=...   # la exige la API para verificar los webhooks
```

**SES.** Las credenciales salen de la cadena estándar del SDK de AWS (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, rol de la instancia...). En `.env`:

```dotenv
MAIL_API_PROVIDER=ses
AWS_REGION=eu-west-1
SES_CONFIGURATION_SET=         # opcional; necesario para recibir eventos por SNS
SES_SNS_TOPIC_ARNS=arn:aws:sns:eu-west-1:123456789012:mail-events   # topics aceptados en el webhook
```

Después, reinicia API y worker y envía con `"transport": { "type": "api" }` (el cliente necesita el transporte `api`). Qué comprobar:

- `GET /v1/emails/<id>` pasa a `sent` con `provider` y `providerMessageId`, y el correo llega con sus adjuntos, cabeceras y la cabecera `X-Mail-Service-Id`.
- Con credenciales erróneas, el mensaje queda en `failed` sin reintentos (`MAILGUN_HTTP_401` o `SES_HTTP_403`).
- En los intentos de `GET` se ve el código de cada error: los transitorios (`..._HTTP_429`, `..._NETWORK_ERROR`, `SES_TooManyRequestsException`...) se reintentan con _backoff_.

### Webhooks de entrega

Los webhooks actualizan el estado de cada destinatario (`delivered`, `bounced`, `complained`, `unsubscribed`) y alimentan la lista de supresión. Son las únicas rutas que se exponen a internet; se autentican por la firma del proveedor, no por API key. Solo existe la ruta del proveedor de `MAIL_API_PROVIDER`.

- **Mailgun** (`POST /v1/webhooks/mailgun`): en el panel del dominio, crea webhooks de `delivered`, `permanent_fail`, `temporary_fail`, `complained` y `unsubscribed` apuntando a `https://<host>/v1/webhooks/mailgun`. La clave de firma (_HTTP webhook signing key_) va en `MAILGUN_WEBHOOK_SIGNING_KEY`.
- **SES** (`POST /v1/webhooks/ses`): en el _configuration set_ de `SES_CONFIGURATION_SET`, crea un destino de eventos de SNS con `Delivery`, `Bounce` y `Complaint`, en un topic de la región de `AWS_REGION`. Añade el ARN del topic a `SES_SNS_TOPIC_ARNS` y suscribe `https://<host>/v1/webhooks/ses` por HTTPS: la API confirma la suscripción sola.

Para probarlos en local hace falta una URL pública que llegue a la API (por ejemplo, un túnel). Al enviar un correo a una dirección de prueba que rebota (`bounce@simulator.amazonses.com` en SES), el destinatario pasa a `bounced`, aparece en `bun run suppressions list` y el siguiente envío por `api` a esa dirección queda `suppressed`.

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

- **Componentes de OpenAPI sin variantes sobrantes.** `fastify-type-provider-zod` emite cada esquema con nombre dos veces (entrada `XInput` y salida `X`). Al generar la especificación se eliminan los componentes que ninguna ruta usa y, si solo se usa la variante de entrada, recupera el nombre sin sufijo (`EmailRequest`, `Address`...).
- **`/health` solo documenta el 200.** Responde siempre que el proceso esté vivo; el 503 es de `/ready`.
- **Cabeceras de petición en minúsculas en la especificación** (`idempotency-key`, `x-request-id`): Fastify exige nombres en minúsculas en los esquemas de cabeceras.
- **`X-Request-Id` recibido** se acepta si cumple `[A-Za-z0-9._:-]{8,128}`; si no, se genera un UUID.
- **Rate limit tolerante a fallos de Redis** (`skipOnError`): si Redis no responde, la petición pasa sin límite. Para 3-4 servicios internos es preferible a rechazar envíos. Las respuestas incluyen además las cabeceras `x-ratelimit-*` del plugin.
- **La API lee `WORKER_MAX_ATTEMPTS` y `WORKER_BACKOFF_BASE_MS`**: las opciones de reintento van en cada job y las fija quien encola, que casi siempre es la API.
- **API con Redis caído**: encolar falla enseguida si la conexión está caída (y, si no, a los 5 s); la petición responde `queued` y el barrido encola el mensaje después. El rate limit deja pasar las peticiones. La conexión de la API no tiene cola offline, el cierre usa `disconnect()` si la conexión no está abierta, y los errores de conexión de ioredis y BullMQ van al log en lugar de a la consola.
- **Límite de adjuntos comprobado en la ruta**, no en el esquema: así el esquema con nombre no depende de `MAX_ATTACHMENTS_BYTES` y la especificación generada es la misma en cualquier entorno.
- **Cabeceras reservadas**: `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Sender`, `Subject`, `Date`, `Message-ID`, `MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`, `Content-Disposition`, `Return-Path`, `DKIM-Signature` y `X-Mail-Service-Id`, sin distinguir mayúsculas. Los nombres de cabecera solo admiten letras, dígitos y guiones.
- **Otros errores 4xx de Fastify** (JSON mal formado, tipo de contenido no admitido) se responden como 400 `VALIDATION_ERROR`.
- **`SmtpHostGuard`**: resuelve con `dns.lookup` (como el resto del sistema, incluye `/etc/hosts` y el DNS de Docker) y conecta a la primera dirección. En IPv6 solo admite unicast global (`2000::/3`), sin documentación, Teredo ni 6to4. `SMTP_ALLOWED_PRIVATE_HOSTS` compara nombres exactos sin distinguir mayúsculas.
- **Keys**: el `keyId` tiene el formato `k_<año>_<mes>_<6 hex>`. Las keys caducadas no cuentan para el máximo de dos activas. `client:create` admite por defecto ambos transportes.
- **La comprobación de `openapi.yaml` vive en `scripts/lib/`**, no en `src/`, porque usa el validador, que es dependencia de desarrollo. `ajv` y `ajv-formats` se añaden como dependencias de desarrollo para el test de contrato de las respuestas.

### Fase 4: proveedores reales

- **SES siempre con `Content.Raw`** (cambio acordado sobre el plan, que pedía `Content.Simple` sin adjuntos ni cabeceras propias). `X-Mail-Service-Id` va en todos los mensajes, y así hay un solo camino: el MIME lo genera `MailComposer` con el mismo mapeo que el envío SMTP, que codifica los nombres no ASCII y las cabeceras. `Destination` se pasa siempre explícito, porque `Bcc` no va en las cabeceras, y sin las listas vacías.
- **Mailgun exige `to`.** Si la supresión deja `to` vacío con destinatarios en `cc` o `bcc`, el adaptador falla sin llamar a la API con `PermanentProviderError` y código `MAILGUN_TO_REQUIRED`; el mensaje queda en `failed`. SES envía sin `To`.
- **Códigos de error guardados en los intentos**: `SMTP_<respuesta>` (`SMTP_550`), `SMTP_AUTH_FAILED`, `SMTP_TLS_CERTIFICATE_INVALID`, `SMTP_RECIPIENTS_REJECTED`, `SMTP_NETWORK_ERROR`, `SMTP_<código de Nodemailer>` y `SMTP_ERROR`; `MAILGUN_HTTP_<estado>`, `MAILGUN_NETWORK_ERROR`, `MAILGUN_TO_REQUIRED` y `MAILGUN_ERROR`; `SES_<nombre del error>`, `SES_HTTP_<estado>`, `SES_NETWORK_ERROR` y `SES_ERROR`.
- **Clasificación SMTP.** Nodemailer entrega los fallos de certificado como `ESOCKET` con el código de Node en `originalCode`: se reconocen por ese código. Una respuesta 4xx gana a `EENVELOPE`: si todos los destinatarios se rechazan y alguno con 4xx (p. ej. _greylisting_), se reintenta. `EAUTH` es permanente aunque la respuesta sea 4xx. Un error sin código (los envíos en cola de un pool que se cierra) es transitorio; cualquier otro código de Nodemailer (`EMESSAGE`, `EPROTOCOL`, `ETLS`...), permanente.
- **Errores de red de Mailgun.** `mailgun.js` entrega los fallos sin respuesta con estado 400 y el código de error como mensaje (`ECONNRESET`, `ECONNABORTED`, `ERR_NETWORK`...). Un 400 cuyo mensaje tiene esa forma se trata como error de red, transitorio.
- **Errores de SES fuera de la tabla.** `$retryable` del SDK, 408, 429 y 5xx, transitorios; el resto de 4xx, permanente (p. ej. credenciales erróneas, `SES_HTTP_403`). Sin estado HTTP, los códigos de red de Node y `TimeoutError` son transitorios; cualquier otro error local, permanente.
- **Pools SMTP sin re-encolados propios** (`maxRequeues: 0`): los reintentos los gestiona solo BullMQ.
- **Caché de transportes SMTP**: el TTL cuenta desde el último uso, de modo que un servidor con tráfico conserva su pool. Al llenarse se expulsa el usado hace más tiempo. Al expulsar un transporte se cierra: los envíos en curso terminan y los que esperaban en su cola fallan como transitorios. El worker cierra todos los pools en el apagado.
- **Tags.** En Mailgun van como `o:tag`. En SES, cada tag es un `EmailTag` con valor `true` y los caracteres que SES no admite (fuera de `[A-Za-z0-9_-]`) sustituidos por `_`, sin repetir nombres, junto al tag `messageId`. SMTP no tiene un lugar estándar para los tags y no los envía; siguen guardados con el mensaje.
- **Imágenes inline en Mailgun.** Mailgun usa el nombre de fichero como `cid`, así que los adjuntos con `contentId` se envían con ese `contentId` como nombre.
- **`providerMessageId` de Mailgun sin `<>`**, igual que llega en los webhooks. El de SMTP se guarda tal como lo devuelve el servidor.
- **Timeouts de los clientes HTTP**: 30 s por petición en Mailgun (`mailgun.js` no pone ninguno por defecto) y en SES, más 10 s de conexión en SES. Son constantes, sin variables de entorno.
- **`form-data` en Mailgun** en lugar del `FormData` nativo: con el nativo, `mailgun.js` pierde el `contentType` de los adjuntos.
- **Sin `verify()` del proveedor en `/ready` de la API**: la API solo tiene las credenciales de los webhooks, no las de envío.
- **`@types/nodemailer` retirado**: Nodemailer 10 incluye sus propios tipos.
- **Los tests de Mailpit** usan `localhost` (incluido en el certificado de desarrollo) y conectan a `127.0.0.1`. El test sin la CA local lanza `test/support/send-to-mailpit.ts` en un proceso hijo sin `NODE_EXTRA_CA_CERTS`.

### Fase 5: webhooks y supresión

- **Respuestas de los webhooks**: 204 si el evento se procesa, se ignora o se repite; 400 si el cuerpo no es válido; 401 `UNAUTHORIZED`, con el mismo mensaje en todos los casos, si la firma no es válida, el certificado o el topic no están permitidos o el timestamp está fuera de plazo (el motivo concreto va al log); 413 por encima de 1 MiB; 500 si falla el procesado.
- **Repeticiones con 204**: un token de Mailgun o un `MessageId` de SNS ya recibido no se procesa, pero se responde 204 para que el proveedor no siga reintentando un evento que ya procesamos.
- **Reserva tras la firma y liberación si falla**: el identificador se reserva en Redis (`SET NX PX`) solo después de verificar la firma y se libera si el procesado falla, para que el reintento del proveedor sí se procese. Todas las instancias de la API comparten la reserva.
- **Ventanas de tiempo**: Mailgun, ±5 min. SNS, hasta 1 h de antigüedad (SNS reintenta con el `Timestamp` original) y 5 min en el futuro. Cada reserva dura lo que su ventana completa.
- **`TopicArn` comprobado en todos los mensajes de SNS**, antes de descargar el certificado: cualquiera puede crear un topic en su cuenta de AWS, suscribir nuestra URL y enviarnos mensajes con firma válida de SNS.
- **URLs de SNS**: `SigningCertURL` y `SubscribeURL` deben ser `https://sns.<AWS_REGION>.amazonaws.com/...`, sin puerto ni credenciales (validado con `URL`, no por subcadena), y el certificado debe terminar en `.pem`. Las descargas no siguen redirecciones y tienen un timeout de 10 s. Los certificados se cachean por URL en memoria; un fallo de descarga no se cachea y responde 500.
- **Eventos de SES** en el formato de publicación de eventos del _configuration set_ (`eventType`). `Bounce` `Transient` o `Undetermined` se registra como fallo temporal, sin supresión. Se ignoran los demás tipos de SES (`Send`, `Open`, `DeliveryDelay`...) y de Mailgun (`accepted`, `opened`, `clicked`...).
- **Límite de cuerpo de 1 MiB en los webhooks**, propio de esas rutas y muy por debajo del de `POST /v1/emails`, porque están expuestas a internet (SNS limita los mensajes a 256 KB).
- **Solo la ruta del proveedor configurado**: si se cambia `MAIL_API_PROVIDER`, los eventos que aún lleguen del proveedor anterior reciben 404. La especificación OpenAPI documenta las dos.
- **CLI de supresiones** con salida separada por tabuladores (`email`, motivo, origen, fecha) y los mensajes más antiguos primero. `add` con una dirección ya suprimida conserva la entrada original. Valida el email y el motivo antes de tocar la base de datos (código 2). El parseo de argumentos se comparte con el CLI de keys en `src/interfaces/cli/cli-support.ts`.
- **Certificado de SNS para tests**: `test/fixtures/sns/` contiene una clave RSA y un certificado autofirmado generados solo para los tests, que firman los mensajes como lo haría SNS.
