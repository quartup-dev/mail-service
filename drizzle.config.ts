import { defineConfig } from 'drizzle-kit';

// Solo para generar migraciones (bun run db:generate), sin conexión a la base de datos.
// Las migraciones se aplican con scripts/migrate.ts (bun run db:migrate)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/db/schema.ts',
  out: './drizzle',
});
