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
bun run dev                 # API en http://localhost:3000
curl http://localhost:3000/health
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
| API                                 | 3000              |
| PostgreSQL                          | 55432             |
| Redis                               | 56379             |
| Mailpit SMTP (STARTTLS obligatorio) | 587               |
| Mailpit web                         | 8025              |

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
- **Errores no clasificados en el worker.** Un error que no es `ProviderError` se trata como transitorio, con código `UNEXPECTED_ERROR`. Un `ProviderError` sin código se guarda como `PROVIDER_ERROR`.
- **Fallos de configuración SMTP en el worker.** Una clave de cifrado desconocida (`SMTP_CONFIG_UNDECRYPTABLE`) o un host que el guard ya no permite (`SMTP_HOST_NOT_ALLOWED`) se convierten en `PermanentProviderError` del proveedor `smtp`: dejan el mensaje en `failed`, registran el intento y se relanzan como cualquier error permanente.
- **Error transitorio en el último intento.** El mensaje queda en `failed` y el error no se relanza: no hay más reintentos.
- **Transporte `api` sin proveedor en el worker.** Si un mensaje `api` llega a un worker sin `MAIL_API_PROVIDER`, queda en `failed` con `API_TRANSPORT_NOT_CONFIGURED`, sin intento registrado.
- **Supresión desde eventos sin correlación.** Un rebote, queja o baja añade la dirección a la supresión aunque el evento no se correlacione con ningún mensaje (por ejemplo, porque la retención ya lo borró): la reputación de la cuenta del proveedor es la misma.
- **Hora del estado por destinatario.** Con eventos, `updatedAt` del destinatario es la hora del evento (`occurredAt`). Con el resultado del worker, es la hora en que se guarda.
- **Barrido.** La caducidad (`EXPIRED`) se repite por lotes hasta que no quedan mensajes. El re-encolado procesa un solo lote por barrido, porque encolar no cambia `updated_at`; el resto queda para el siguiente.
- **Retención de payloads por `updated_at`.** `clearPayloads` usa la fecha en que el mensaje pasó a estado final, que es su `updated_at`: los estados finales no cambian.
- **El host SMTP no se repite en `email_attempts`.** Ya está en `emails.smtp_host`, y el esquema de la fase 2 no tiene esa columna en los intentos.
- **Repositorios en memoria en `src/infrastructure/db/in-memory/`** y sus tests de contrato en `test/contracts/`, para reutilizarlos con Drizzle en la fase 2. Los fakes de proveedores, guard, cola, logger y reloj están en `test/support/`.
