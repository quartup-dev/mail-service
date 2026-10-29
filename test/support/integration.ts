import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { Database } from '../../src/infrastructure/db/client';
import { apiClients } from '../../src/infrastructure/db/schema';

// Servicios de docker compose; se pueden sobrescribir con variables de entorno
const POSTGRES_URL = process.env.TEST_POSTGRES_URL ?? 'postgres://mail:mail@localhost:55432';
export const TEST_DATABASE_URL = `${POSTGRES_URL}/mail_test`;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379';

export const TEST_CLIENT_IDS = ['billing', 'crm'] as const;

// Crea la base de datos vacía (la borra antes si existe)
export async function recreateDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: `${POSTGRES_URL}/postgres` });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return `${POSTGRES_URL}/${name}`;
}

// Deja las tablas vacías y crea los clientes que usan los tests (emails.client_id es FK)
export async function resetTables(db: Database): Promise<void> {
  await db.execute(sql`
    TRUNCATE email_events, email_attempts, email_recipients, emails, suppressions, api_keys, api_clients
    RESTART IDENTITY CASCADE
  `);
  const now = new Date('2026-01-01T00:00:00.000Z');
  await db.insert(apiClients).values(
    TEST_CLIENT_IDS.map((id) => ({
      id,
      name: id,
      status: 'active' as const,
      allowedTransports: ['smtp' as const, 'api' as const],
      createdAt: now,
      updatedAt: now,
    })),
  );
}
