import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env.js';
import * as schema from './schema.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  // Render's managed Postgres (and most hosted PG) requires SSL. The internal
  // CA is self-signed, so rejectUnauthorized=false is needed. Local dev hits
  // a plaintext localhost socket — disable SSL there to avoid handshake errors.
  ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export { schema };
