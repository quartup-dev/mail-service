# Plan de implementación: mail-service

- **Fecha:** 2026-10-29
- **Reglas del proyecto:** [.claude/CLAUDE.md](../../.claude/CLAUDE.md) (stack, arquitectura, invariantes de seguridad y forma de trabajar)
- **Método:** TDD estricto, según CLAUDE.md.

### Cómo usar este plan con TDD

- Los criterios de aceptación de cada fase son el punto de partida de la lista de casos de prueba, no la lista completa.
- Al empezar una fase, añade bajo ella una sección **"Casos de prueba"** con la lista de comportamientos (casillas), ampliando los criterios con casos límite y de error. Márcalos a medida que pasan de rojo a verde.
- Una fase no está terminada mientras quede algún caso sin marcar o algún criterio sin un test que lo cubra (salvo las excepciones de CLAUDE.md, que se verifican con su criterio de aceptación).

## Estado

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Andamiaje | Completada |
| 1 | Dominio y casos de uso | Completada |
| 2 | Persistencia, colas y worker | Pendiente |
| 3 | API HTTP y autenticación | Pendiente |
| 4 | Proveedores reales | Pendiente |
| 5 | Webhooks y supresión | Pendiente |
| 6 | Producción | Pendiente |

---

## Alcance

**Incluido:**
- `POST /v1/emails` para solicitar envíos y `GET /v1/emails/:id` para consultar su estado.
- Dos transportes, elegidos en cada petición:
  - `smtp`: la petición trae el servidor SMTP y sus credenciales.
  - `api`: el proveedor lo fija la configuración (`MAIL_API_PROVIDER`). El cliente no lo elige.
- Envío asíncrono con colas y worker, reintentos y barrido de pendientes.
- Estado de envío por mensaje y estado de entrega por destinatario, alimentado por webhooks de Mailgun y SES.
- Lista de supresión global para el transporte `api`.
- Autenticación por API key, con CLI de gestión.
- Retención de datos.

**Fuera de alcance:**
- Despliegue serverless.
- Avisos salientes a los servicios consumidores (callbacks). Los consumidores consultan `GET /v1/emails/:id`.
- Perfiles SMTP guardados por cliente: las credenciales llegan en cada petición.
- Fallback entre transportes o proveedores: cada petición usa exactamente el transporte pedido.
- Patrón outbox. La consistencia entre base de datos y cola se garantiza con re-encolado idempotente y barrido periódico.
- Supresión por cliente.

## Decisiones de diseño

Además del stack de CLAUDE.md:

| Tema | Decisión | Motivo |
|---|---|---|
| Proveedor API | Uno solo, fijado por `MAIL_API_PROVIDER` (`mailgun` o `ses`). Vacío = transporte `api` deshabilitado | El cliente pide "api" y el servicio decide cuál. |
| Colas | Una por transporte: `emails-api` y `emails-smtp`, más `maintenance` | Un servidor SMTP lento no consume la capacidad ni la tasa de los envíos por API. |
| Garantía de envío | **Al menos una vez** | Si el worker cae tras enviar y antes de marcar `sent`, el correo puede duplicarse. Se documenta en el README. |
| Seguimiento | Estado de envío por mensaje + estado de entrega por destinatario | Un mensaje puede entregarse a unos destinatarios y rebotar en otros. |
| Supresión | Global, solo para `transport: "api"`, gestionada por CLI | Todos los clientes comparten la cuenta y la reputación del proveedor. Con SMTP el servidor es del cliente. |
| Credenciales SMTP en reposo | AES-256-GCM con clave activa y clave anterior opcional | Permite rotar la clave sin perder mensajes pendientes. |
| API keys | Tablas en PostgreSQL, solo hashes HMAC, sin caché | Revocación inmediata en todas las instancias; sin ficheros que montar ni recargar. |
| Rate limit | Por cliente, ventana fija de un minuto, en Redis | Suficiente para 3-4 servicios internos. |
| Gestor de paquetes | Bun, solo para instalar y lanzar scripts; Node 24 como runtime | Instalación rápida sin cambiar el runtime: Fastify, Nodemailer, BullMQ y `NODE_EXTRA_CA_CERTS` están probados en Node, y desarrollo y producción usan el mismo. |
| Contrato de la API | `openapi.yaml` generado desde las rutas y versionado | Los consumidores tienen un contrato detallado que no puede quedarse desfasado respecto al código. |

---

## Fase 0: andamiaje

**Tareas:**
- Proyecto con Bun como gestor de paquetes (`bun.lock` versionado; `packageManager` y `engines.node` = 24 en `package.json`), TypeScript `strict`, ESLint (incluida la regla de restricción de imports entre capas), Prettier, Vitest, tsup y tsx. Todos los scripts ejecutan sobre Node (CLAUDE.md).
- Scripts de `package.json` de CLAUDE.md (los que aún no tengan implementación pueden quedar como marcador).
- `docker-compose.yml` con PostgreSQL, Redis y Mailpit.
- **Mailpit con TLS verificable** (el servicio solo admite los puertos 465 y 587 y nunca desactiva la verificación de certificados):
  - `scripts/dev-certs.sh` genera en `docker/dev-certs/` (en `.gitignore`) una CA local y un certificado para Mailpit con SAN `mailpit` y `localhost`, firmado por esa CA. Puede usar `mkcert` u `openssl`. Es idempotente: si los ficheros existen, no los regenera.
  - Mailpit escucha SMTP en el **puerto 587** con STARTTLS obligatorio y ese certificado. Consulta en la documentación vigente de Mailpit los nombres exactos de las opciones (p. ej. `MP_SMTP_BIND_ADDR`, `MP_SMTP_TLS_CERT`, `MP_SMTP_TLS_KEY`, `MP_SMTP_REQUIRE_STARTTLS`).
  - El worker y los tests de integración arrancan con `NODE_EXTRA_CA_CERTS=./docker/dev-certs/ca.pem`. Node solo lee esta variable al arrancar el proceso. Solo en desarrollo y test.
- Vitest configurado antes que cualquier código de producción, con los scripts `test`, `test:watch` y `test:integration`.
- Primeros ciclos TDD: `GET /health` (rojo con `app.inject()` contra un `buildApp()` que aún no existe, luego verde), `config.ts` con esquemas por proceso (anexo A; cada validación con su test) y la redacción de `logger.ts` (un test por campo sensible de CLAUDE.md).
- `.env.example` con las variables del anexo A, sin secretos reales y con `SMTP_ALLOWED_PRIVATE_HOSTS=mailpit,localhost`.

**Aceptación:**
- [x] `bun install` desde cero y `bun run dev` levantan la API, y `GET /health` responde 200.
- [x] `bun run lint`, `bun run typecheck` y `bun run test` pasan.
- [x] `/health`, `config.ts` y la redacción de logs tienen tests escritos antes que el código (visible en el historial de commits).
- [x] El proceso de la API corre sobre Node 24, no sobre Bun (comprobado con `process.versions.bun` indefinido en `/health` en desarrollo o en un test).
- [x] Una conexión STARTTLS a Mailpit en el 587 con `rejectUnauthorized: true` y la CA local se establece correctamente.

**Casos de prueba:**

*Health y runtime*
- [x] `GET /health` responde 200 con `{ "status": "ok" }`.
- [x] Los tests se ejecutan sobre Node, no sobre Bun.

*Configuración (`loadConfig(kind, env)`; `kind`: `api`, `worker`, `keys-cli`, `suppressions-cli`)*
- [x] `api` con un entorno mínimo válido carga y aplica los valores por defecto del anexo A.
- [x] `worker` con un entorno mínimo válido carga y aplica los valores por defecto del anexo A.
- [x] Sin `DATABASE_URL` falla en los cuatro procesos, y el error nombra la variable.
- [x] `REDIS_URL` es obligatoria en `api` y `worker`, no en los CLIs.
- [x] `SMTP_CREDENTIALS_ENCRYPTION_KEY` es obligatoria en `api` y `worker`, no en los CLIs.
- [x] `SMTP_CREDENTIALS_ENCRYPTION_KEY` y `API_KEY_PEPPER` rechazan valores que no sean 32 bytes en base64.
- [x] `API_KEY_PEPPER` es obligatoria en `api` y `keys-cli`, no en `worker` ni `suppressions-cli`.
- [x] `SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` es opcional, y si se define debe ser distinta de la activa.
- [x] Rechaza `PAYLOAD_RETENTION_DAYS` > `EVENTS_RETENTION_DAYS` o `EVENTS_RETENTION_DAYS` > `MESSAGE_RETENTION_DAYS`.
- [x] Con `NODE_ENV=production`, rechaza `SMTP_ALLOWED_PRIVATE_HOSTS` no vacío.
- [x] `MAIL_API_PROVIDER` vacío deja el proveedor sin definir; un valor desconocido falla.
- [x] Con `mailgun`: `api` exige `MAILGUN_WEBHOOK_SIGNING_KEY`; `worker` exige `MAILGUN_API_KEY` y `MAILGUN_DOMAIN`.
- [x] Con `ses`: `api` y `worker` exigen `AWS_REGION`; `api` exige `SES_SNS_TOPIC_ARNS`.
- [x] Las listas separadas por comas se convierten en arrays sin espacios ni elementos vacíos.
- [x] `WORKER_QUEUES` solo admite `api` y `smtp`.
- [x] Las variables numéricas rechazan valores no enteros o no positivos.
- [x] Un entorno con varios errores los informa todos en un único error.
- [x] El mensaje de error nunca incluye el valor de una variable secreta.

*Logger*
- [x] Redacta la cabecera `authorization` de las peticiones.
- [x] Redacta `smtp.auth.pass` en la raíz y un nivel por debajo (`*.smtp.auth.pass`).
- [x] Redacta `dkim.privateKey` en la raíz y un nivel por debajo.
- [x] Redacta `apiKey` y `smtpConfigEncrypted` en la raíz y un nivel por debajo.
- [x] Usa el nivel de `LOG_LEVEL`.

*Mailpit (integración)*
- [x] STARTTLS en el 587 con verificación activa y la CA local se establece.

---

## Fase 1: dominio y casos de uso

Todo en `domain/` y `application/`, con adaptadores en memoria y fakes (`FakeApiProvider`, `FakeSmtpSender`, `FakeSmtpHostGuard`, `FakeClock`). Sin infraestructura real, salvo `SecretBox`, que solo usa `node:crypto`. Es la fase con más ciclos TDD: cada regla del dominio y cada paso de los casos de uso entra con su test.

### 1.1 Modelo de dominio

```ts
export interface Address {
  email: string;
  name?: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  contentBase64: string;   // por ahora en línea; en el futuro, referencia a S3
  contentId?: string;      // para imágenes inline (cid:)
}

export interface EmailMessage {
  id: string;              // UUID v7 generado por el servicio
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string;           // al menos uno de text/html es obligatorio
  attachments?: Attachment[];
  headers?: Record<string, string>;
  tags?: string[];
  metadata?: Record<string, string>;
  transport: TransportSpec;
}

export type TransportSpec =
  | { type: 'smtp'; smtp: SmtpServerConfig }
  | { type: 'api' };          // el proveedor lo decide MAIL_API_PROVIDER

export interface SmtpServerConfig {
  host: string;
  port: 465 | 587;            // el 25 no se admite. El modo TLS se deduce del puerto:
                              // 465 → TLS implícito; 587 → STARTTLS obligatorio
  auth?: { user: string; pass: string };
  dkim?: { domainName: string; keySelector: string; privateKey: string };
}

export type ApiProviderName = 'mailgun' | 'ses';
export type ProviderName = 'smtp' | ApiProviderName;

// Ciclo de envío del mensaje completo
export type EmailStatus =
  | 'queued'      // pendiente de envío (también entre reintentos)
  | 'sending'     // un worker lo está procesando
  | 'sent'        // aceptado por el servidor SMTP o el proveedor API
  | 'failed'      // error permanente, reintentos agotados o caducado
  | 'suppressed'; // todos los destinatarios estaban suprimidos

export const FINAL_EMAIL_STATUSES: readonly EmailStatus[] = ['sent', 'failed', 'suppressed'];

export type RecipientKind = 'to' | 'cc' | 'bcc';

export type RecipientStatus =
  | 'pending'       // aún no enviado
  | 'suppressed'    // omitido por la lista de supresión
  | 'rejected'      // rechazado por el servidor SMTP en el RCPT TO
  | 'accepted'      // aceptado por el servidor o proveedor
  | 'delivered'     // confirmado por evento del proveedor
  | 'bounced'       // rebote permanente
  | 'complained'    // marcado como spam
  | 'unsubscribed'; // baja solicitada por el destinatario

export interface EmailRecipient {
  email: string;            // en minúsculas
  kind: RecipientKind;
  status: RecipientStatus;
  updatedAt: Date;
}
```

### 1.2 Estado por destinatario

El estado del mensaje (`EmailStatus`) describe solo el **envío**. La **entrega** se sigue por destinatario.

- Al crear el mensaje, cada destinatario de `to`, `cc` y `bcc` empieza en `pending`. No se admiten direcciones repetidas entre `to`, `cc` y `bcc` (comparación en minúsculas).
- Al enviar: los suprimidos pasan a `suppressed`; los aceptados, a `accepted`; los rechazados por SMTP, a `rejected`.
- El estado solo **avanza**, nunca retrocede. Rangos: `pending` (0) < `accepted` (1) < `delivered` (2) < `bounced` | `complained` | `unsubscribed` (3) < `suppressed` | `rejected` (9). El rango 9 es final: nada lo sobrescribe.
- La regla vale **tanto para los eventos como para las escrituras del worker**: un webhook puede llegar antes de que el worker guarde el resultado del envío, y el `accepted` del worker no debe pisar un `delivered` o `bounced`.
- Un evento con rango menor o igual al actual se registra en `email_events`, pero no cambia el estado.
- La transición es atómica en la base de datos: `UPDATE ... WHERE status_rank < rango_nuevo`.
- Con SMTP no hay eventos: los destinatarios terminan en `accepted` o `rejected`.

### 1.3 Errores

```ts
export abstract class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly code?: string,
    options?: { cause?: unknown },
  ) { super(message, options); }
}
export class TransientProviderError extends ProviderError {}  // reintentable
export class PermanentProviderError extends ProviderError {}  // no reintentar
```

La clasificación concreta de cada proveedor está en la fase 4.

### 1.4 Puertos

```ts
export interface SendResult {
  provider: ProviderName;
  providerMessageId: string;
  acceptedAt: Date;
  rejectedRecipients?: string[];   // solo SMTP: destinatarios rechazados en el RCPT TO
}

// Proveedor de API configurado globalmente (Mailgun, SES...)
export interface EmailApiProvider {
  readonly name: ApiProviderName;
  send(message: EmailMessage): Promise<SendResult>;   // lanza ProviderError
  verify?(): Promise<void>;                           // comprobación en /ready
}

// Envío SMTP contra el servidor indicado en cada petición, conectando a la IP ya validada
export interface SmtpSender {
  send(message: EmailMessage, server: SmtpServerConfig, target: { ip: string }): Promise<SendResult>;
}

// Validación anti-SSRF de hosts SMTP (fase 3 la implementa con DNS real)
export interface SmtpHostGuard {
  // Devuelve la IP validada a la que conectar o lanza SmtpHostNotAllowedError
  resolveAndValidate(host: string, port: number): Promise<{ host: string; ip: string }>;
}

// Reloj inyectable: barrido, retención y caducidad de keys no leen la hora del sistema directamente
export interface Clock {
  now(): Date;
}

export interface SecretBox {
  encrypt(plain: string): string;    // siempre con la clave activa
  decrypt(cipher: string): string;   // con la clave activa o la anterior, según el keyId
}

export interface EmailQueue {
  // Encola en la cola del transporte (emails-api o emails-smtp).
  // Idempotente: si ya existe un job con jobId = messageId, no hace nada
  enqueue(messageId: string, transport: 'smtp' | 'api'): Promise<void>;
  close(): Promise<void>;
}

// StoredEmail, AttemptRecord, StoredEvent y SuppressionEntry reflejan las filas de las
// tablas de la fase 2 (StoredEmail incluye sus destinatarios e intentos).

export interface CreateEmailInput {
  message: EmailMessage;           // sin credenciales SMTP en claro
  clientId: string;
  requestId: string;
  requestHash: string;             // hash del cuerpo para la comparación de idempotencia
  idempotencyKey?: string;
  smtpConfigEncrypted?: string;    // salida de SecretBox.encrypt, solo con transport smtp
}

export interface EmailRepository {
  // Inserta mensaje y destinatarios en una transacción. Si ya existe (client_id, idempotency_key),
  // no inserta y devuelve el existente con created = false (también ante peticiones simultáneas)
  create(input: CreateEmailInput): Promise<{ email: StoredEmail; created: boolean }>;
  findById(id: string): Promise<StoredEmail | null>;
  findByProviderMessageId(provider: ProviderName, providerMessageId: string): Promise<StoredEmail | null>;
  updateStatus(id: string, status: EmailStatus, patch?: Partial<StoredEmail>): Promise<void>;
  recordAttempt(id: string, attempt: AttemptRecord): Promise<void>;
  // Actualización en lote desde el worker; respeta el rango igual que advanceRecipientStatus
  setRecipientStatuses(id: string, updates: Array<{ email: string; status: RecipientStatus }>): Promise<void>;
  // Aplica la transición solo si el rango nuevo es mayor; devuelve si se aplicó
  advanceRecipientStatus(id: string, email: string, status: RecipientStatus, occurredAt: Date): Promise<boolean>;
  // Mensajes en queued o sending filtrados por created_at y/o updated_at (para el barrido)
  findPending(filter: { createdBefore?: Date; updatedBefore?: Date }, limit: number): Promise<StoredEmail[]>;
  // Guarda un evento de proveedor (emailId nulo si no se correlacionó)
  recordEvent(event: StoredEvent): Promise<void>;
  // Retención: cada método procesa como máximo `limit` filas y devuelve cuántas afectó
  clearPayloads(finalBefore: Date, limit: number): Promise<number>;
  deleteEvents(receivedBefore: Date, limit: number): Promise<number>;
  deleteFinalEmails(createdBefore: Date, limit: number): Promise<number>;
}

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface SuppressionRepository {
  findSuppressed(emails: string[]): Promise<Set<string>>;   // una consulta para todos los destinatarios
  add(email: string, reason: SuppressionReason, source: ProviderName | 'cli'): Promise<void>;
  remove(email: string): Promise<void>;
  list(opts?: { reason?: SuppressionReason; limit?: number; offset?: number }): Promise<SuppressionEntry[]>;
}

export interface ApiClient {
  id: string;
  name: string;
  allowedTransports: Array<'smtp' | 'api'>;
  allowedFromDomains?: string[];
  rateLimitPerMinute?: number;
}

export interface ApiClientRepository {
  authenticate(rawKey: string): Promise<ApiClient | null>;
}
```

### 1.5 Casos de uso

**`QueueEmail`** (lo invoca `POST /v1/emails`, ya autenticado y validado por esquema):
1. Comprobar que el cliente puede usar el transporte pedido (`TRANSPORT_NOT_ALLOWED`).
2. Con `api`: rechazar si no hay proveedor configurado (`API_TRANSPORT_NOT_CONFIGURED`) y validar el dominio de `from` contra los `allowedFromDomains` del cliente o, si no tiene, `ALLOWED_FROM_DOMAINS` (`FROM_DOMAIN_NOT_ALLOWED`). Reglas de coincidencia de dominios:
   - Sin distinguir mayúsculas.
   - `example.com` coincide **solo** con `example.com`, no con subdominios.
   - `*.example.com` coincide con cualquier subdominio (`mail.example.com`, `a.b.example.com`), pero **no** con `example.com`.
3. Con `smtp`: validar el host con `SmtpHostGuard` (`SMTP_HOST_NOT_ALLOWED`) y cifrar la configuración SMTP (incluida la clave DKIM) con `SecretBox`. Con SMTP no se valida el dominio de `from`: lo valida el servidor del cliente.
4. Calcular `requestHash` del cuerpo **sustituyendo** la contraseña SMTP y la clave DKIM por su HMAC con `API_KEY_PEPPER`.
5. `EmailRepository.create`:
   - Creado → encolar y devolver `queued`. Si el `enqueue` falla, registrar un aviso y devolver igualmente `queued`: el barrido lo encolará.
   - Ya existía con el mismo `requestHash` → devolver el existente. Si está en `queued` o `sending`, volver a llamar a `enqueue` (seguro, porque `jobId = messageId`).
   - Ya existía con otro `requestHash` → `IDEMPOTENCY_CONFLICT`.

**`ProcessEmailJob`** (lo invoca el consumidor de BullMQ con `messageId`, `attempt` y `maxAttempts`):
1. Cargar el mensaje. Si está en un estado final, terminar sin enviar. Si está en `queued` o `sending`, continuar (`sending` indica que un worker anterior cayó a mitad de envío).
2. Solo con `api`: consultar la supresión de todos los destinatarios con `findSuppressed`. Los suprimidos pasan a `suppressed` y no se envían. Si no queda ninguno, el mensaje pasa a `suppressed`.
3. Marcar `sending`. Con SMTP: descifrar la configuración y ejecutar `SmtpHostGuard` para obtener la IP a la que conectar.
4. Enviar por el transporte del mensaje. Sin fallback.
5. Registrar el intento con `recordAttempt` (transporte, proveedor, resultado, código, duración; con SMTP, el host, nunca las credenciales).
6. Éxito: `sent` con `providerMessageId`; destinatarios a `accepted` o `rejected` con `setRecipientStatuses`.
7. Error transitorio con intentos restantes: volver a `queued` y relanzar el error.
8. Error transitorio en el último intento (`attempt >= maxAttempts`): `failed` con código y motivo.
9. Error permanente: `failed` con código y motivo, y relanzar el `PermanentProviderError`. El consumidor lo convierte en `UnrecoverableError` (fase 2).
10. En cualquier estado final, borrar la configuración SMTP cifrada (`smtp_config_encrypted = NULL`).

**`HandleProviderEvent`** (lo invocan los webhooks, fase 5):
- Correlación: primero por el id interno que enviamos con el mensaje; si no viene, por (`provider`, `providerMessageId`).
- Guardar siempre el evento con `recordEvent` (con `emailId` nulo si no se correlaciona).
- Actualizar **solo el destinatario afectado** con `advanceRecipientStatus`.
- Supresiones: rebote permanente → `bounce`; queja → `complaint`; baja → `unsubscribe`.

**`GetEmailStatus`**: devuelve el mensaje solo si pertenece al cliente que pregunta; si no, "no encontrado".

**`SweepPendingEmails`**, por lotes:
1. Mensajes en `queued` o `sending` con `created_at` anterior a `PENDING_MAX_AGE_MS` (24 h) → `failed` con código `EXPIRED` y borrado de la configuración SMTP cifrada. Ninguna credencial permanece más de ese tiempo.
2. Mensajes en `queued` o `sending` con `updated_at` anterior a `STALE_PENDING_AFTER_MS` (10 min) → `enqueue`. Si el job sigue existiendo no pasa nada; si se perdió, se vuelve a crear.

**`ApplyRetention`**, por lotes (p. ej. 1000 filas por sentencia, repitiendo hasta que no queden):
1. Vaciar el `payload` (con adjuntos) de los mensajes finales con más de `PAYLOAD_RETENTION_DAYS` (7).
2. Borrar los eventos con más de `EVENTS_RETENTION_DAYS` (90).
3. Borrar los mensajes finales con más de `MESSAGE_RETENTION_DAYS` (365), con sus destinatarios, intentos y eventos.
- Nunca toca mensajes pendientes ni la tabla `suppressions`.

### 1.6 SecretBox

- Formato del texto cifrado: `<keyId>:<base64url(iv ‖ tag ‖ ciphertext)>`, con AES-256-GCM, IV aleatorio de 12 bytes y tag de 16 bytes. `keyId` son los 8 primeros caracteres hex del SHA-256 de la clave.
- `encrypt` usa siempre `SMTP_CREDENTIALS_ENCRYPTION_KEY`. `decrypt` elige la clave por `keyId` entre la activa y `SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`. Si no coincide ninguna, el error es permanente y el mensaje pasa a `failed` con código `SMTP_CONFIG_UNDECRYPTABLE`.
- Rotación (a documentar en el README): mover la clave actual a `..._PREVIOUS`, poner la nueva como activa y desplegar API y worker. Pasadas `PENDING_MAX_AGE_MS`, retirar `..._PREVIOUS`.

**Aceptación** (tests unitarios, sin infraestructura real):
- [x] Flujo completo de envío por ambos transportes.
- [x] Idempotencia: misma key y cuerpo devuelve el existente y lo re-encola si está pendiente; cuerpo distinto da conflicto; el hash no depende de la contraseña SMTP en claro.
- [x] Supresión: aplicada solo con `api`, parcial y total.
- [x] Estado por destinatario: `accepted`/`rejected` en SMTP; transiciones monótonas con eventos desordenados y duplicados; un `delivered` que llega antes del resultado del worker no se pisa con `accepted`; `suppressed` y `rejected` no cambian.
- [x] Reintentos: un error transitorio en el último intento deja `failed`; un error permanente deja `failed` y se relanza como `PermanentProviderError`.
- [x] Reglas de coincidencia de dominios: exacto, comodín, dominio raíz no cubierto por `*.`, mayúsculas.
- [x] Cifrado, borrado de credenciales SMTP en estado final, descifrado con la clave anterior y `SMTP_CONFIG_UNDECRYPTABLE` con clave desconocida.
- [x] Barrido: re-encolado de pendientes y caducidad `EXPIRED` con borrado de credenciales.
- [x] Rechazo de `api` sin proveedor configurado.
- [x] Cobertura ≥ 80 % en `domain/` y `application/`.

**Casos de prueba:**

*Dominio: coincidencia de dominios (`matchesDomainPattern`)*
- [x] Un dominio exacto coincide sin distinguir mayúsculas.
- [x] Un dominio exacto no coincide con sus subdominios.
- [x] `*.example.com` coincide con subdominios de cualquier nivel.
- [x] `*.example.com` no coincide con `example.com`.
- [x] Un patrón no coincide con un dominio que solo termina igual (`badexample.com`).

*Dominio: estado por destinatario*
- [x] El estado avanza a un rango mayor.
- [x] El estado no retrocede ni cambia con el mismo rango.
- [x] `suppressed` y `rejected` son finales.

*SecretBox (`AesGcmSecretBox`)*
- [x] Descifra lo que cifra.
- [x] El texto cifrado tiene el formato `<keyId>:<base64url>` con el `keyId` de la clave activa.
- [x] Dos cifrados del mismo texto son distintos (IV aleatorio).
- [x] Descifra con la clave anterior.
- [x] Un `keyId` desconocido lanza `UndecryptableSecretError`.
- [x] Un texto cifrado manipulado o mal formado lanza `UndecryptableSecretError`.

*Hash de la petición (`computeRequestHash`)*
- [x] La misma petición produce el mismo hash.
- [x] Peticiones distintas producen hashes distintos.
- [x] Con SMTP, el hash depende del *pepper*: la contraseña y la clave DKIM entran como HMAC, no en claro.
- [x] Cambiar la contraseña SMTP o la clave DKIM cambia el hash.

*Repositorio de emails en memoria (contrato del puerto, reutilizable en la fase 2)*
- [x] `create` guarda el mensaje en `queued` con sus destinatarios en `pending`, en minúsculas y con su tipo.
- [x] `create` guarda transporte, host y puerto SMTP y la configuración cifrada.
- [x] `create` con la misma `idempotencyKey` y cliente devuelve el existente con `created = false`.
- [x] La misma `idempotencyKey` en otro cliente crea un mensaje nuevo.
- [x] `findById` devuelve `null` si no existe, y modificar lo devuelto no altera lo guardado.
- [x] `findByProviderMessageId` encuentra por proveedor e id.
- [x] `updateStatus` aplica el estado, el *patch* y `updatedAt`.
- [x] `recordAttempt` añade intentos.
- [x] `setRecipientStatuses` avanza los estados y no los retrocede.
- [x] `advanceRecipientStatus` devuelve si aplicó la transición (también con un destinatario desconocido).
- [x] `findPending` filtra por estado pendiente, `createdBefore`, `updatedBefore` y límite.
- [x] `recordEvent` y `deleteEvents` borran solo los eventos anteriores a la fecha, hasta el límite.
- [x] `clearPayloads` vacía solo payloads de mensajes finales anteriores a la fecha, hasta el límite, y no cuenta los ya vacíos.
- [x] `deleteFinalEmails` borra solo mensajes finales anteriores a la fecha, con sus eventos, hasta el límite.

*Repositorio de supresiones en memoria (contrato del puerto)*
- [x] `findSuppressed` devuelve las direcciones suprimidas sin distinguir mayúsculas.
- [x] `add` es idempotente y `remove` quita la dirección.
- [x] `list` filtra por motivo y pagina.

*QueueEmail*
- [x] Con `api`: crea el mensaje en `queued` y lo encola en la cola `api`.
- [x] Rechaza un transporte no permitido al cliente (`TRANSPORT_NOT_ALLOWED`).
- [x] Rechaza `api` sin proveedor configurado (`API_TRANSPORT_NOT_CONFIGURED`).
- [x] Con `api`, valida el dominio de `from` con los dominios del cliente; si no tiene, con los globales (`FROM_DOMAIN_NOT_ALLOWED`).
- [x] Con `smtp`: rechaza un host que el guard no permite (`SMTP_HOST_NOT_ALLOWED`).
- [x] Con `smtp`: guarda la configuración cifrada (incluida DKIM) y el `payload` sin contraseña ni clave DKIM.
- [x] Con `smtp`: no valida el dominio de `from`.
- [x] Si el `enqueue` falla, registra un aviso y devuelve igualmente `queued`.
- [x] Idempotencia: misma key y cuerpo devuelve el existente y lo re-encola si está pendiente.
- [x] Idempotencia: un existente en estado final no se re-encola.
- [x] Idempotencia: misma key y cuerpo SMTP no da conflicto aunque el cifrado cambie.
- [x] Idempotencia: misma key con otro cuerpo da `IDEMPOTENCY_CONFLICT`.

*ProcessEmailJob*
- [x] Con `api`: envía, deja `sent` con proveedor, `providerMessageId` y `sentAt`, destinatarios en `accepted` y un intento `success`.
- [x] Con `smtp`: descifra la configuración, valida el host, envía a la IP validada y borra la configuración cifrada.
- [x] Con `smtp`: los destinatarios rechazados quedan en `rejected` y el resto en `accepted`.
- [x] Un mensaje en estado final o inexistente no se envía.
- [x] Un mensaje en `sending` se envía.
- [x] Supresión parcial con `api`: los suprimidos quedan en `suppressed` y no se les envía.
- [x] Supresión total con `api`: el mensaje queda en `suppressed` y no se envía.
- [x] La supresión no se aplica con `smtp`.
- [x] Un `delivered` registrado antes del resultado del worker no se pisa con `accepted`.
- [x] Error transitorio con intentos restantes: vuelve a `queued`, registra el intento y relanza.
- [x] Error transitorio en el último intento: `failed` con código y motivo, y configuración SMTP borrada.
- [x] Error permanente: `failed`, configuración SMTP borrada y relanza `PermanentProviderError`.
- [x] Un error sin clasificar se trata como transitorio.
- [x] Configuración cifrada con la clave anterior: se descifra y se envía.
- [x] Clave desconocida: `failed` con `SMTP_CONFIG_UNDECRYPTABLE` como error permanente.
- [x] Host rechazado por el guard en el worker: `failed` con `SMTP_HOST_NOT_ALLOWED` como error permanente.
- [x] `api` sin proveedor configurado en el worker: `failed` con `API_TRANSPORT_NOT_CONFIGURED`.

*Flujo completo*
- [x] `QueueEmail` + `ProcessEmailJob` por `api` termina en `sent`.
- [x] `QueueEmail` + `ProcessEmailJob` por `smtp` termina en `sent` sin configuración cifrada.

*HandleProviderEvent*
- [x] Correlaciona por id interno y avanza solo el destinatario afectado.
- [x] Sin id interno, correlaciona por (`provider`, `providerMessageId`).
- [x] Un evento sin correlación se guarda con `emailId` nulo.
- [x] Eventos desordenados o duplicados se guardan, pero no retroceden el estado.
- [x] Rebote, queja y baja añaden la dirección a supresión con su motivo; `delivered` y fallos temporales no.

*GetEmailStatus*
- [x] Devuelve el mensaje del cliente que pregunta.
- [x] Devuelve "no encontrado" para un mensaje de otro cliente o inexistente.

*SweepPendingEmails*
- [x] Caduca los pendientes con más de `PENDING_MAX_AGE_MS` (`failed`, `EXPIRED`, configuración borrada).
- [x] Re-encola los pendientes sin actividad en `STALE_PENDING_AFTER_MS`.
- [x] No toca mensajes recientes ni finales.
- [x] Caduca por lotes hasta que no quedan.

*ApplyRetention*
- [x] Vacía payloads, borra eventos y borra mensajes finales según sus plazos.
- [x] No toca mensajes pendientes.
- [x] Procesa por lotes hasta que no quedan filas.

---

## Fase 2: persistencia, colas y worker

### 2.1 Esquema (Drizzle)

Todas las tablas se crean en esta fase, incluidas las de clientes, porque `emails.client_id` es FK.

**Tests de contrato de los puertos:** los repositorios en memoria de la fase 1 y los de Drizzle de esta fase pasan la **misma** batería de tests, escrita como función parametrizada por la implementación (`describeEmailRepositoryContract(factory)`). El repositorio Drizzle se desarrolla haciendo pasar, uno a uno, los tests que ya pasa el de memoria.

- **`emails`**: `id` (uuid, PK), `client_id` (FK a `api_clients`), `idempotency_key` (nullable; único junto con `client_id`), `request_hash`, `request_id`, `payload` (jsonb, **sin** credenciales SMTP), `transport` (`smtp` | `api`), `smtp_host`, `smtp_port`, `smtp_config_encrypted` (text, nullable), `status`, `provider`, `provider_message_id`, `error_code`, `error_message`, `created_at`, `updated_at`, `sent_at`.
  - Índice único en (`provider`, `provider_message_id`).
  - Índices en (`status`, `updated_at`) y (`status`, `created_at`).
- **`email_recipients`**: `email_id` (FK, `ON DELETE CASCADE`), `email` (minúsculas), `kind`, `status`, `status_rank` (smallint), `last_event_at`, `updated_at`. PK (`email_id`, `email`).
- **`email_attempts`**: `id`, `email_id` (FK, `ON DELETE CASCADE`), `attempt`, `transport`, `provider`, `outcome` (`success` | `transient_error` | `permanent_error`), `code`, `message`, `duration_ms`, `created_at`.
- **`email_events`**: `id`, `email_id` (FK nullable, `ON DELETE CASCADE`), `recipient` (nullable), `provider`, `type`, `raw` (jsonb), `occurred_at`, `received_at`. Índice en `received_at`.
- **`suppressions`**: `email` (PK, minúsculas), `reason`, `source`, `created_at`.
- **`api_clients`**: `id` (text, PK, `[a-z0-9-]{3,32}`), `name`, `status` (`active` | `disabled`), `allowed_transports` (text[]), `allowed_from_domains` (text[], nullable), `rate_limit_per_minute` (integer, nullable), `created_at`, `updated_at`. Los clientes no se borran, solo se desactivan.
- **`api_keys`**: `client_id` (FK), `key_id` (text), `hash` (text), `status` (`active` | `revoked`), `created_at`, `expires_at` (nullable), `revoked_at` (nullable). PK (`client_id`, `key_id`).

### 2.2 Colas y worker

- Adaptador BullMQ de `EmailQueue` con `jobId = messageId`. El job solo lleva el `messageId`. Jobs con `removeOnComplete` y `removeOnFail`: la base de datos es la fuente de verdad.
- **`emails-api`**: concurrencia `WORKER_API_CONCURRENCY` y *limiter* global `WORKER_API_RATE_LIMIT_PER_SECOND`, ajustado a la cuota del proveedor.
- **`emails-smtp`**: concurrencia `WORKER_SMTP_CONCURRENCY`, sin *limiter* global (el ritmo se limita por servidor en el pool SMTP, fase 4).
- `WORKER_QUEUES=api,smtp` permite arrancar solo una de las dos. La cola `maintenance` la atienden **todos** los procesos worker.
- Reintentos: `attempts` = `WORKER_MAX_ATTEMPTS` (5), backoff exponencial con jitter y base `WORKER_BACKOFF_BASE_MS` (30 s).
- El consumidor de emails pasa `attempt` y `maxAttempts` a `ProcessEmailJob` y convierte `PermanentProviderError` en `UnrecoverableError` de BullMQ.
- El worker lee `request_id` del mensaje y lo añade a sus logs, junto a `messageId`, `clientId`, `transport`, `provider` y `attempt`.
- **Mantenimiento** con job schedulers de BullMQ (`upsertJobScheduler`) en la cola `maintenance`, para que corran una sola vez por intervalo aunque haya varias réplicas: `SweepPendingEmails` cada `SWEEP_INTERVAL_MS` (60 s) y `ApplyRetention` cada hora.
- **Health del worker**: servidor mínimo con `node:http` en `WORKER_HEALTH_PORT` (3001), con `/health` (el proceso responde) y `/ready` (PostgreSQL y Redis accesibles y workers en marcha). Durante el apagado, `/ready` responde 503. No se publica fuera del contenedor.
- **Apagado ordenado** con `SIGTERM`/`SIGINT`: dejar de aceptar jobs, terminar los activos y cerrar conexiones.

**Aceptación** (tests de integración con Docker Compose):
- [ ] Los repositorios Drizzle pasan los mismos tests de contrato que sus versiones en memoria.
- [ ] Crear, encolar y procesar por ambos transportes con los fakes; estado final `sent` y `smtp_config_encrypted` a `NULL`.
- [ ] Un mensaje guardado sin job en Redis acaba enviado gracias al barrido.
- [ ] `advanceRecipientStatus` y `setRecipientStatuses` no retroceden el estado con actualizaciones concurrentes.
- [ ] `create` con la misma `Idempotency-Key` en paralelo inserta un solo mensaje.
- [ ] Con un `FakeSmtpSender` lento que ocupa toda la concurrencia de `emails-smtp`, los mensajes de `emails-api` se procesan sin retraso.
- [ ] Un error permanente no genera reintentos (un único registro en `email_attempts`); uno transitorio repetido agota `WORKER_MAX_ATTEMPTS` y deja `failed`.
- [ ] `/health` y `/ready` del worker responden, y `/ready` devuelve 503 durante el apagado.
- [ ] La retención vacía payloads, borra eventos y borra mensajes según sus plazos, no toca pendientes ni supresiones, y procesa por lotes (probado con más filas que el tamaño de lote).

---

## Fase 3: API HTTP y autenticación

### 3.1 Organización en Fastify

- `buildApp(deps)` crea la instancia y registra los plugins, **sin `listen`**. `server.ts` llama a `listen` y gestiona el apagado. Los tests usan `app.inject()`.
- Opciones de la instancia:
  - `loggerInstance`: el Pino de `logger.ts`. No se registran cuerpos de petición.
  - `bodyLimit`: `MAX_BODY_BYTES`.
  - `genReqId`: UUID propio; se acepta el de `X-Request-Id` si tiene formato válido. Se devuelve en esa cabecera y se guarda como `request_id` del mensaje.
  - Validador y serializador de `fastify-type-provider-zod`.
- Plugins encapsulados:
  - `/v1/emails`: hook `onRequest` de autenticación (decora `request.client`) y después `@fastify/rate-limit` con almacén en Redis, `keyGenerator` = `clientId`, `max` = `rateLimitPerMinute` del cliente (o `RATE_LIMIT_DEFAULT_PER_MINUTE`) y ventana de un minuto. El rate limit va **después** de la autenticación.
  - `/v1/webhooks/*` (fase 5): sin API key ni rate limit por cliente.
  - `/health`, `/ready` y `/docs`: sin autenticación. `/ready` comprueba PostgreSQL, Redis y, si existe, `verify()` del proveedor API.
- Un único `setErrorHandler` y un `setNotFoundHandler` producen el formato de error de 3.5. El 429 se construye con `errorResponseBuilder` del plugin de rate limit.
- `server.ts` llama a `app.close()` en `SIGTERM`/`SIGINT`; las conexiones se cierran en hooks `onClose`.
- OpenAPI con `@fastify/swagger` a partir de los esquemas Zod, servida en `/docs` con `@fastify/swagger-ui` y exportada a `openapi.yaml` (3.7).

### 3.2 Autenticación

- Cabecera `Authorization: Bearer <api-key>` en todas las rutas `/v1/*` salvo webhooks.
- Formato de la key: `ms_<clientId>_<secret>`.
  - `clientId`: `[a-z0-9-]{3,32}`.
  - `secret`: 32 bytes de `crypto.randomBytes` en base64url.
  - Se separa solo por los dos primeros `_`, porque base64url puede contener `_` y `-`.
- Hash: `createHmac('sha256', API_KEY_PEPPER).update(secret)`, guardado como `hmac-sha256:<base64>`.
- Verificación: cargar el cliente y sus keys activas y no caducadas por clave primaria y comparar con `crypto.timingSafeEqual`. **Sin caché**: una revocación tiene efecto inmediato.
- Máximo **2 keys activas** por cliente, para rotar sin cortes.
- Respuestas:
  - **401** `UNAUTHORIZED`, con el mismo mensaje genérico en todos los casos: key ausente, mal formada, desconocida, revocada o caducada, o cliente desactivado.
  - **403** `TRANSPORT_NOT_ALLOWED` o `FROM_DOMAIN_NOT_ALLOWED`.
  - **429** `RATE_LIMITED` con `Retry-After`.
- Aislamiento: cada mensaje guarda el `client_id`; `GET` de un mensaje de otro cliente devuelve **404**; la `Idempotency-Key` es única por cliente; todos los logs llevan `clientId`.

### 3.3 CLI de clientes y keys (`bun run keys <comando>`)

- `client:create --id billing --name "..." [--transports smtp,api] [--from-domains example.com] [--rate-limit 120]`
- `client:update --id billing [--transports ...] [--from-domains ...] [--rate-limit ...]`
- `client:disable --id billing` / `client:enable --id billing`
- `key:create --client billing [--expires-at 2027-10-29]`: imprime la key **una sola vez**. Falla si el cliente ya tiene 2 keys activas.
- `key:revoke --client billing --key-id k_2026_10`
- `list`: clientes y keys, sin hashes.
- Cada comando en una transacción. `key:create` bloquea la fila del cliente (`SELECT ... FOR UPDATE`) antes de contar las keys activas.
- Necesita `DATABASE_URL` y `API_KEY_PEPPER`. Se compila con tsup a `dist/scripts/`, porque la imagen final no lleva Bun ni tsx.

### 3.4 Endpoints

**`POST /v1/emails`**
- Cabecera opcional `Idempotency-Key` (máx. 255 caracteres).
- Cuerpo: `EmailMessage` sin `id`; `transport` obligatorio.
- Validación de esquema (400):
  - emails válidos y al menos un destinatario en `to`;
  - sin direcciones repetidas entre `to`, `cc` y `bcc`;
  - `subject` no vacío y `text` o `html` obligatorio;
  - máximo 50 destinatarios en total y adjuntos **decodificados** ≤ `MAX_ATTACHMENTS_BYTES`;
  - sin saltos de línea en `subject`, nombres ni cabeceras personalizadas, y sin cabeceras reservadas (`From`, `To`, `Cc`, `Bcc`, `Subject`, `Content-Type`, `MIME-Version`...);
  - con `smtp`: objeto `smtp` obligatorio y puerto 465 o 587 (no existe el campo `secure`);
  - con `api`: no se admite el objeto `smtp`.
- **202** `{ "id": "...", "status": "queued", "transport": "smtp" | "api" }` si se crea.
- **200** con el mensaje existente si la `Idempotency-Key` ya existe para ese cliente con el mismo cuerpo; **409** `IDEMPOTENCY_CONFLICT` si el cuerpo es distinto.

Ejemplos:

```json
{
  "transport": {
    "type": "smtp",
    "smtp": {
      "host": "smtp.example.com",
      "port": 587,
      "auth": { "user": "notificaciones@example.com", "pass": "••••••" }
    }
  },
  "from": { "email": "notificaciones@example.com", "name": "Example" },
  "to": [{ "email": "cliente@dominio.com" }],
  "subject": "Bienvenido",
  "html": "<p>Hola</p>",
  "text": "Hola"
}
```

```json
{
  "transport": { "type": "api" },
  "from": { "email": "notificaciones@example.com" },
  "to": [{ "email": "cliente@dominio.com" }],
  "subject": "Bienvenido",
  "text": "Hola"
}
```

**`GET /v1/emails/:id`**
- Devuelve estado de envío, transporte, proveedor, `providerMessageId`, intentos, fechas, destinatarios con su estado y un resumen por estado. **Nunca** devuelve credenciales SMTP; como mucho, `host` y `port`.

```json
{
  "id": "0192f0c4-...",
  "status": "sent",
  "transport": "api",
  "provider": "mailgun",
  "providerMessageId": "20261029.abc@mg.example.com",
  "recipients": [
    { "email": "a@dominio.com", "kind": "to", "status": "delivered", "updatedAt": "..." },
    { "email": "b@dominio.com", "kind": "cc", "status": "bounced", "updatedAt": "..." }
  ],
  "deliverySummary": { "delivered": 1, "bounced": 1 },
  "attempts": [],
  "createdAt": "...",
  "sentAt": "..."
}
```

### 3.5 Formato de error

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [], "requestId": "..." } }
```

- **400** `VALIDATION_ERROR`: el cuerpo no cumple el esquema. `details` lleva los errores de Zod.
- **401**, **403**, **404**, **409**, **429**: según 3.2 y 3.4.
- **413** `PAYLOAD_TOO_LARGE`: cuerpo mayor que `MAX_BODY_BYTES`.
- **422**: petición válida que la política o la configuración impiden atender (`SMTP_HOST_NOT_ALLOWED`, `API_TRANSPORT_NOT_CONFIGURED`).
- **500** `INTERNAL_ERROR`: sin detalles internos; el detalle va al log con el `requestId`.

### 3.6 SmtpHostGuard (implementación real)

Se implementa en esta fase porque la API lo necesita para el 422; el worker lo reutiliza en la fase 4.

- Resolver el host (todas las direcciones A y AAAA) y rechazar si **alguna** IP es privada, loopback, link-local, multicast, reservada o IPv4 mapeada en IPv6 hacia esos rangos. Si el host es una IP literal, se valida directamente.
- Excepción: hosts en `SMTP_ALLOWED_PRIVATE_HOSTS` (nombres de host, solo desarrollo). En producción el arranque falla si no está vacía.
- Solo puertos 465 y 587.
- Si `SMTP_ALLOWED_HOSTS` está definido, el host debe coincidir con la lista (mismas reglas de comodín que los dominios de `from`).
- Devuelve `{ host, ip }` con la IP a la que conectar.

### 3.7 Contrato OpenAPI y `openapi.yaml`

El fichero `openapi.yaml` de la raíz del repositorio es el contrato de la API para los servicios consumidores. Se genera desde las rutas y nunca se edita a mano.

**Esquemas de las rutas:**
- Cada ruta declara en `schema` su `summary`, `tags`, `params`, `querystring`, `headers` y `body` cuando aplique, y en `response` un esquema por **cada** código que puede devolver, incluidos los de error:

  | Ruta | Respuestas |
  |---|---|
  | `POST /v1/emails` | 202, 200, 400, 401, 403, 409, 413, 422, 429, 500 |
  | `GET /v1/emails/:id` | 200, 400, 401, 404, 429, 500 |
  | `POST /v1/webhooks/*` (fase 5) | 200 o 204, 400, 401 (firma inválida), 413, 500 |
  | `GET /health`, `GET /ready` | 200, 503 |

- Los esquemas de respuesta son **detallados**: cada campo con su tipo, formato (`uuid`, `email`, `date-time`), `enum` cuando aplique, obligatoriedad, `nullable` explícito y `description`. Prohibidos en respuestas `z.any()`, `z.unknown()`, `z.object({}).passthrough()` y equivalentes. Los únicos mapas permitidos son los que ya son parte del modelo (`metadata: Record<string, string>`).
- Esquemas con nombre, reutilizados como `components.schemas` y referenciados con `$ref` (en Zod 4, con `.meta({ id })` o un registro; consulta la documentación vigente de `fastify-type-provider-zod` para registrarlos). Como mínimo:
  - `EmailRequest`, `SmtpTransport`, `ApiTransport`, `Address`, `Attachment`;
  - `EmailAccepted` (respuesta 202/200 de `POST`);
  - `EmailStatusResponse`, `EmailRecipientStatus`, `EmailAttempt`, `DeliverySummary`;
  - `EmailStatus`, `RecipientStatus`, `RecipientKind`, `TransportType`, `ProviderName` como enums;
  - `ErrorResponse`, con `code` como **enum** de todos los códigos de error del servicio y `details` como array de `ValidationIssue` (`path`, `message`, `code`), no como objeto genérico;
  - `HealthResponse`, `ReadyResponse` (estado de cada dependencia).
- Cada código de error documenta qué valores de `ErrorResponse.code` puede devolver en su `description` (p. ej. el 403 de `POST /v1/emails`: `TRANSPORT_NOT_ALLOWED`, `FROM_DOMAIN_NOT_ALLOWED`).
- Cabeceras documentadas: `Authorization` (como `securitySchemes.bearerAuth`, aplicado a `/v1/emails*`), `Idempotency-Key` en la petición, `X-Request-Id` en petición y respuestas, y `Retry-After` en el 429.
- Ejemplos (`examples`) en `POST /v1/emails` para ambos transportes y en `GET /v1/emails/:id`, sin credenciales reales.
- Los esquemas de respuesta también los usa el serializador de Fastify: cualquier campo no declarado se descarta al responder, lo que evita filtrar por error datos internos como la configuración SMTP.

**Exportación (`bun run openapi:export`):**
- Script `scripts/export-openapi.ts`, ejecutado con `tsx` (sobre Node).
- Construye la app con `buildApp(deps)` usando adaptadores en memoria y fakes, **sin** conectar a PostgreSQL ni Redis y sin necesitar secretos: la configuración de exportación no exige variables de entorno.
- Llama a `app.ready()`, obtiene la especificación con `app.swagger({ yaml: true })` y la escribe en `openapi.yaml`.
- Salida **determinista**: mismo código, mismo fichero byte a byte. Sin fechas, sin URLs de servidor tomadas del entorno; `info.version` sale de `package.json`.
- Versión OpenAPI 3.1 (o 3.0.3 si la herramienta no soporta 3.1; anotarlo en "Decisiones").
- `/docs` y sus recursos no aparecen en la especificación.

**Comprobación (`bun run openapi:check`):**
- Regenera la especificación en memoria y la compara con `openapi.yaml`; falla con un mensaje claro si difieren ("ejecuta `bun run openapi:export`").
- Valida el fichero con un validador de OpenAPI (p. ej. `@apidevtools/swagger-parser` o `@redocly/cli lint`).
- Se ejecuta al cerrar cada fase desde la 3 y en CI.

**Aceptación:**
- [ ] Repositorio de clientes: key válida, key con `_` y `-` en el secreto, revocada, caducada, cliente desactivado, `clientId` inexistente.
- [ ] CLI: creación de cliente y key, revocación con efecto inmediato en la API sin reiniciarla, rechazo de una tercera key activa, dos `key:create` simultáneos que no superan el máximo.
- [ ] La base de datos solo contiene hashes; ninguna key en claro en tablas ni logs.
- [ ] Integración de la API: 400 por esquema (incluidas cabeceras reservadas y saltos de línea), 413, 401, 403 por transporte y por dominio, 429, aislamiento entre clientes en `GET`, 202 por ambos transportes, 200 y 409 de idempotencia, 404, 422 `SMTP_HOST_NOT_ALLOWED` y `API_TRANSPORT_NOT_CONFIGURED`.
- [ ] Las rutas de webhooks no exigen API key ni consumen rate limit, y una petición sin autenticar a `/v1/emails` tampoco lo consume.
- [ ] `SmtpHostGuard`: IPv4/IPv6 privadas, IPv4 mapeadas en IPv6, loopback, link-local, hostname que resuelve a IP privada (también si solo una de varias lo es), puertos no permitidos, lista blanca con comodines.
- [ ] Ninguna respuesta ni log contiene la contraseña SMTP.
- [ ] `/docs` muestra la especificación.
- [ ] `bun run openapi:export` genera `openapi.yaml` sin servicios levantados ni variables de entorno, y dos ejecuciones seguidas producen un fichero idéntico.
- [ ] `openapi.yaml` pasa el validador; todas las rutas tienen esquema para cada código de la tabla de 3.7; no hay ningún esquema de respuesta sin propiedades definidas (comprobado por un test que recorre la especificación); `ErrorResponse.code` es un enum.
- [ ] `bun run openapi:check` falla si se cambia un esquema de ruta sin regenerar, y pasa tras regenerar.
- [ ] Un test de contrato comprueba con `app.inject()` que las respuestas reales de 202, 200, 400, 401, 404, 409 y 429 cumplen su esquema de `openapi.yaml`.

---

## Fase 4: proveedores reales

### 4.1 Requisitos comunes

- Mapear `EmailMessage` al formato de cada transporte sin perder adjuntos, cc/bcc, reply-to, cabeceras ni tags.
- Incluir el id interno para correlacionar eventos: cabecera `X-Mail-Service-Id` en todos, `v:messageId` en Mailgun y tag `messageId` en SES.
- Clasificar los errores con esta tabla. Cada adaptador aplica primero sus casos explícitos y, si no encaja ninguno, la última fila:

| Origen | Transitorio | Permanente |
|---|---|---|
| Red | timeouts, `ECONNRESET`, `ECONNREFUSED`, DNS | — |
| SMTP | 4xx (421, 450, 451, 452) | 5xx (550, 553, 554); autenticación (535, `EAUTH`); host bloqueado por `SmtpHostGuard`; certificado TLS inválido; todos los destinatarios rechazados (`EENVELOPE`) |
| Mailgun (HTTP) | 429, 5xx | 400, 401, 403, 404 |
| SES | `TooManyRequestsException`, `ThrottlingException`, `LimitExceededException`, 5xx | `MessageRejected`, `MailFromDomainNotVerifiedException`, `AccountSuspendedException`, `SendingPausedException`, `BadRequestException`, `NotFoundException` |
| Cualquier otro | sin respuesta (red), `$retryable` del SDK de AWS, HTTP 408, 429 o 5xx | resto de 4xx y errores de validación local |

### 4.2 SmtpSender (Nodemailer)

- **Conexión a la IP validada** (anti *DNS rebinding*): el transporte se crea con `host: <ip>` y `tls: { servername: <host original> }`, para que SNI y la verificación del certificado usen el nombre original. Con una IP literal no se pone `servername`.
- **TLS** deducido del puerto: 465 → `secure: true`; 587 → `secure: false` y `requireTLS: true`. Siempre `rejectUnauthorized: true`.
- **Caché de transportes** con `pool: true`, por hash de (`host`, `ip`, `port`, `user`, hash de `pass`), TTL `SMTP_TRANSPORT_CACHE_TTL_MS` y máximo `SMTP_TRANSPORT_CACHE_MAX`. Si cambia la IP, entrada nueva. Cerrar el transporte al expulsarlo.
- **DKIM por mensaje** (opción `dkim` de `sendMail`), nunca al crear el transporte: la clave de caché no lo incluye.
- **Límite por servidor**: `maxConnections` = `SMTP_POOL_MAX_CONNECTIONS`, `rateLimit` = `SMTP_RATE_LIMIT_PER_SECOND` con `rateDelta: 1000`.
- Timeouts de conexión, saludo y socket (`SMTP_*_TIMEOUT_MS`).
- Si solo algunos destinatarios se rechazan, el envío tiene éxito y esos van en `rejectedRecipients`.

### 4.3 Mailgun

- `mailgun.js` con `form-data`; región EU (`https://api.eu.mailgun.net`) o US según `MAILGUN_REGION`.
- `v:messageId` como variable personalizada.

### 4.4 SES

- `SESv2Client` con `maxAttempts: 1` (los reintentos los gestiona solo la cola) y `SendEmailCommand`.
- Con adjuntos o cabeceras personalizadas, construir el MIME con `MailComposer` de Nodemailer y enviar como `Content.Raw`; si no, `Content.Simple`.
- Credenciales por la cadena estándar del SDK. `ConfigurationSetName` desde `SES_CONFIGURATION_SET` para recibir eventos.

**Aceptación:**
- [ ] Tests unitarios de cada adaptador simulando el cliente (sin red), con cada fila de la tabla de clasificación y la regla por defecto.
- [ ] `SmtpSender` crea el transporte con la IP validada y `tls.servername` igual al host original; un cambio de IP genera una entrada de caché nueva; la DKIM se pasa por mensaje.
- [ ] E2E contra Mailpit (STARTTLS en el 587, verificación activa con la CA local): el correo llega con asunto, cuerpo y adjuntos correctos.
- [ ] Sin la CA local, el envío falla con error permanente de certificado. Como Node solo lee `NODE_EXTRA_CA_CERTS` al arrancar, este test lanza un **proceso hijo** sin esa variable que intenta el envío e informa del resultado. No se añade ninguna opción para inyectar CAs en `SmtpSender`.
- [ ] Mailgun y SES quedan documentados en el README para probarlos manualmente con credenciales reales.

---

## Fase 5: webhooks y supresión

### 5.1 `POST /v1/webhooks/mailgun`

- Firma: HMAC-SHA256 de `timestamp + token` con `MAILGUN_WEBHOOK_SIGNING_KEY`, comparación en tiempo constante. Rechazar timestamps de más de 5 minutos y tokens repetidos (en Redis, con TTL de al menos 5 minutos).
- Eventos: `delivered`, `failed` con `severity: permanent` (rebote), `complained`, `unsubscribed`. Los `failed` temporales solo se registran.
- Correlación por `user-variables.messageId`; si no viene, por `providerMessageId` sin `<>`.

### 5.2 `POST /v1/webhooks/ses`

- Notificaciones de SNS por HTTPS. SNS envía `Content-Type: text/plain`: registrar con `addContentTypeParser` un parser que haga `JSON.parse`, **solo dentro del plugin** de esta ruta.
- Firma de SNS:
  - `SignatureVersion` `1` (SHA1withRSA) o `2` (SHA256withRSA); cualquier otro valor se rechaza.
  - `SigningCertURL` con `https`, host `sns.<region>.amazonaws.com` (validado con `new URL()`, no por subcadena) y ruta terminada en `.pem`. Certificado cacheado por URL.
  - Cadena a firmar con los campos y el orden de la documentación de SNS para cada tipo de mensaje.
- `SubscriptionConfirmation`: confirmar automáticamente solo si el `TopicArn` está en `SES_SNS_TOPIC_ARNS`.
- Eventos: `Delivery`, `Bounce` (solo `Permanent` es rebote y va a supresión; `Transient` solo se registra), `Complaint`. Correlación por el tag `messageId`.

### 5.3 Lista de supresión

- Global y solo para `transport: "api"`. Se consulta en `ProcessEmailJob` (fase 1).
- CLI `bun run suppressions <comando>`: `list [--reason bounce|complaint|unsubscribe|manual]`, `add --email x@dominio.com` (motivo `manual`), `remove --email x@dominio.com`. No hay gestión por HTTP.

**Aceptación:**
- [ ] Payloads firmados de ejemplo: válidos, firma incorrecta, timestamp caducado y repetidos.
- [ ] SNS: `SignatureVersion` 1 y 2, versión desconocida, `SigningCertURL` con `http`, con un host ajeno o con un host que solo contiene `amazonaws.com` como subcadena (p. ej. `sns.eu-west-1.amazonaws.com.evil.example`).
- [ ] Un evento que llega antes de guardar el `providerMessageId` se correlaciona por id interno.
- [ ] En un mensaje con dos destinatarios, uno `delivered` y otro `bounced`, cada uno queda con su estado.
- [ ] Un rebote permanente añade el destinatario a supresión y bloquea envíos posteriores por `api`, pero no por `smtp`.
- [ ] `suppressions remove` permite volver a enviar.
- [ ] `openapi.yaml` regenerado incluye los dos webhooks con sus esquemas de petición y respuesta, y `bun run openapi:check` pasa.

---

## Fase 6: producción

- `Dockerfile` multi-stage:
  - Etapa de build: `bun install --frozen-lockfile` y `bun run build` (tsup corre sobre Node, así que la etapa necesita Node 24 y Bun; p. ej. imagen `node:24` con el binario de Bun copiado desde la imagen oficial de Bun).
  - Etapa de dependencias: `bun install --frozen-lockfile --production`.
  - Imagen final `node:24-slim` (o equivalente): solo `node_modules` de producción y `dist/` (incluido `dist/scripts/`), **sin Bun**, usuario no root con UID/GID `10001:10001`.
- Compose con `api`, `worker` y `tools` (perfil `tools`, no arranca con `docker compose up`), misma imagen con distinto comando. `tools` tiene `DATABASE_URL` y `API_KEY_PEPPER`.
- El Compose es de desarrollo: el `worker` monta `docker/dev-certs/` en solo lectura y define `NODE_EXTRA_CA_CERTS`. En producción no se monta la CA, no se define `NODE_EXTRA_CA_CERTS` y `SMTP_ALLOWED_PRIVATE_HOSTS` queda vacío.
- `HEALTHCHECK` para `api` y `worker`.
- **Exposición**: la API se sirve siempre por TLS (directamente o tras un proxy inverso) y solo en la red interna, salvo `POST /v1/webhooks/mailgun` y `POST /v1/webhooks/ses`, que el proxy expone a internet.
- **README** en español:
  - arquitectura, configuración, ejecución local y despliegue;
  - ejemplo de proxy inverso que solo exponga los webhooks;
  - CLIs de keys y supresiones;
  - procedimiento de rotación de `SMTP_CREDENTIALS_ENCRYPTION_KEY`;
  - garantía "al menos una vez" y política de retención (incluido que tras `MESSAGE_RETENTION_DAYS` el `GET` da 404 y la `Idempotency-Key` queda libre);
  - aviso de que los dominios permitidos deben estar verificados en el proveedor;
  - sección "Decisiones".

**Aceptación:**
- [ ] `docker compose up` levanta todo y un envío de extremo a extremo funciona contra Mailpit.
- [ ] Una key creada con `docker compose run --rm tools node dist/scripts/keys.js key:create ...` funciona en la API en ejecución sin reiniciarla, y al revocarla la API responde 401 en la siguiente petición.
- [ ] La imagen con `NODE_ENV=production` se niega a arrancar si `SMTP_ALLOWED_PRIVATE_HOSTS` no está vacío.
- [ ] `bun audit` sin vulnerabilidades conocidas de severidad alta (si la versión de Bun no lo soporta, usar la alternativa que indique su documentación y anotarlo en "Decisiones").

---

## Anexo A: configuración

Variables de entorno validadas con Zod al arrancar. Cada proceso valida solo lo que usa:

| Variable | API | Worker | CLI |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | ✓ |
| `REDIS_URL` | ✓ | ✓ | — |
| `SMTP_CREDENTIALS_ENCRYPTION_KEY` | ✓ (cifra) | ✓ (descifra) | — |
| `API_KEY_PEPPER` | ✓ | — | ✓ (`keys`) |
| Variables del proveedor de `MAIL_API_PROVIDER` | ✓ (webhooks) | ✓ (envío) | — |

Reglas adicionales:
- `SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS`, si se define, debe ser distinta de la activa.
- `PAYLOAD_RETENTION_DAYS` ≤ `EVENTS_RETENTION_DAYS` ≤ `MESSAGE_RETENTION_DAYS`.
- Con `NODE_ENV=production`, `SMTP_ALLOWED_PRIVATE_HOSTS` debe estar vacío.

```dotenv
# General
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
ALLOWED_FROM_DOMAINS=example.com     # para transport=api si el cliente no define los suyos

# Autenticación y límites de petición
API_KEY_PEPPER=                      # 32 bytes en base64
RATE_LIMIT_DEFAULT_PER_MINUTE=120
MAX_BODY_BYTES=15728640
MAX_ATTACHMENTS_BYTES=10485760

# Infraestructura
DATABASE_URL=postgres://mail:mail@localhost:55432/mail   # puerto publicado por docker-compose.yml
REDIS_URL=redis://localhost:56379

# Proveedor para transport=api (vacío = transporte api deshabilitado)
MAIL_API_PROVIDER=mailgun            # mailgun | ses

# SMTP (los datos del servidor llegan en cada petición; aquí solo política y límites)
SMTP_CREDENTIALS_ENCRYPTION_KEY=     # 32 bytes en base64 (clave activa)
SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS=   # opcional, solo durante una rotación
SMTP_ALLOWED_HOSTS=                  # opcional, ej: smtp.example.com,*.example.org
SMTP_ALLOWED_PRIVATE_HOSTS=          # solo desarrollo: mailpit,localhost
# NODE_EXTRA_CA_CERTS=./docker/dev-certs/ca.pem   # solo desarrollo
SMTP_POOL_MAX_CONNECTIONS=5          # por servidor SMTP
SMTP_RATE_LIMIT_PER_SECOND=5         # por servidor SMTP
SMTP_TRANSPORT_CACHE_TTL_MS=300000
SMTP_TRANSPORT_CACHE_MAX=50
SMTP_CONNECTION_TIMEOUT_MS=10000
SMTP_GREETING_TIMEOUT_MS=10000
SMTP_SOCKET_TIMEOUT_MS=30000

# Mailgun
MAILGUN_API_KEY=
MAILGUN_DOMAIN=
MAILGUN_REGION=eu                    # eu | us
MAILGUN_WEBHOOK_SIGNING_KEY=

# SES
AWS_REGION=eu-west-1
SES_CONFIGURATION_SET=
SES_SNS_TOPIC_ARNS=

# Worker
WORKER_QUEUES=api,smtp
WORKER_HEALTH_PORT=3001
WORKER_API_CONCURRENCY=10
WORKER_API_RATE_LIMIT_PER_SECOND=10  # ajustar a la cuota del proveedor
WORKER_SMTP_CONCURRENCY=10
WORKER_MAX_ATTEMPTS=5
WORKER_BACKOFF_BASE_MS=30000

# Mantenimiento
SWEEP_INTERVAL_MS=60000
STALE_PENDING_AFTER_MS=600000        # re-encolar pendientes sin actividad en 10 min
PENDING_MAX_AGE_MS=86400000          # caducar pendientes de más de 24 h
PAYLOAD_RETENTION_DAYS=7
EVENTS_RETENTION_DAYS=90
MESSAGE_RETENTION_DAYS=365
```
