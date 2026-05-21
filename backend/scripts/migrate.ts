import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '../src/config/env.js';

const { Pool } = pg;

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
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
