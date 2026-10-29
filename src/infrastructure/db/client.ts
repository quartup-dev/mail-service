import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
}

// Un único pool por proceso, creado en el contenedor
export function connectDatabase(databaseUrl: string): DatabaseConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return { db: drizzle({ client: pool, schema }), pool };
}
