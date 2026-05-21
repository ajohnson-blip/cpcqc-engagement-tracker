import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '../src/config/env.js';

const { Pool } = pg;

async function main() {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // SSL required by Render/most hosted PG; rejectUnauthorized: false for
    // their self-signed internal CA. Local dev keeps plaintext localhost.
    ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool);
  // eslint-disable-next-line no-console
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  // eslint-disable-next-line no-console
  console.log('Done.');
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
