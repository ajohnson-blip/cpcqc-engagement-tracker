import 'dotenv/config';
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cpcqc:cpcqc@localhost:5432/cpcqc_tracker',
  },
  strict: true,
  verbose: true,
} satisfies Config;
