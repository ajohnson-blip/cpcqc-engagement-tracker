/**
 * Create a user from the command line.
 *
 * Usage:
 *   npm run create-user -- --email=you@cpcqc.org --password=changeme123 --role=cpcqc_admin --first-name=Amber --last-name=Johnson
 *
 * Roles: hospital_user | hospital_admin | cpcqc_staff | cpcqc_admin
 */
import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { sql } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

interface Args {
  email: string;
  password: string;
  role: 'hospital_user' | 'hospital_admin' | 'cpcqc_staff' | 'cpcqc_admin';
  firstName?: string;
  lastName?: string;
  hospitalId?: string;
}

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (m) out[m[1]!] = m[2]!;
  }
  const role = out['role'] as Args['role'];
  if (!out['email'] || !out['password'] || !role) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: npm run create-user -- --email=... --password=... --role=... [--first-name=...] [--last-name=...] [--hospital-id=...]',
    );
    process.exit(1);
  }
  if (!['hospital_user', 'hospital_admin', 'cpcqc_staff', 'cpcqc_admin'].includes(role)) {
    // eslint-disable-next-line no-console
    console.error(`Invalid role: ${role}`);
    process.exit(1);
  }
  return {
    email: out['email']!,
    password: out['password']!,
    role,
    firstName: out['first-name'],
    lastName: out['last-name'],
    hospitalId: out['hospital-id'],
  };
}

async function main() {
  const args = parseArgs();
  if (args.password.length < 12) {
    // eslint-disable-next-line no-console
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const existing = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${args.email})`,
  });
  if (existing) {
    // eslint-disable-next-line no-console
    console.error(`User with email ${args.email} already exists (id=${existing.id}).`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(args.password);
  const id = uuid();
  await db.insert(schema.users).values({
    id,
    email: args.email,
    passwordHash,
    firstName: args.firstName ?? null,
    lastName: args.lastName ?? null,
    role: args.role,
    hospitalId: args.hospitalId ?? null,
  });
  // eslint-disable-next-line no-console
  console.log(`Created user ${args.email} (${args.role}) with id ${id}.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
