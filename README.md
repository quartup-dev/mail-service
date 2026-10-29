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
