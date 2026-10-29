import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

// Relativa al directorio de trabajo: la raíz del repositorio en desarrollo y /app en la imagen
export const MIGRATIONS_FOLDER = 'drizzle';

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
