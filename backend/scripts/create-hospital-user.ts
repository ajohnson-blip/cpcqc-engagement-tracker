/**
 * Create a hospital-scoped user account by hospital name.
 *
 * Looks up the hospital by exact name and creates a user linked to it. Use
 * this for setting up smoke-test accounts or onboarding a hospital's first
 * admin before the team has a UI for inviting users.
 *
 * Usage:
 *   tsx scripts/create-hospital-user.ts \
 *     --hospital="Denver Health Medical Center" \
 *     --email=admin@denverhealth.example \
 *     --password=Welcome2026!cpcqc \
 *     --role=hospital_admin \
 *     --first-name=Test \
 *     --last-name=Admin
 *
 * Roles: hospital_user | hospital_admin
 *   hospital_admin: can see all enrollments + tasks for the hospital, edit profile
 *   hospital_user:  read-only for non-admin staff at the hospital
 */
import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

interface Args {
  hospital: string;
  email: string;
  password: string;
  role: 'hospital_user' | 'hospital_admin';
  firstName?: string;
  lastName?: string;
}

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (m) out[m[1]!] = m[2]!;
  }
  const role = out['role'] as Args['role'];
  if (!out['hospital'] || !out['email'] || !out['password'] || !role) {
    // eslint-disable-next-line no-console
    console.error(
      'Usage: tsx scripts/create-hospital-user.ts --hospital="..." --email=... --password=... --role=hospital_admin [--first-name=...] [--last-name=...]',
    );
    process.exit(1);
  }
  if (!['hospital_user', 'hospital_admin'].includes(role)) {
    // eslint-disable-next-line no-console
    console.error(`Invalid role: ${role}. Must be hospital_user or hospital_admin.`);
    process.exit(1);
  }
  return {
    hospital: out['hospital']!,
    email: out['email']!,
    password: out['password']!,
    role,
    firstName: out['first-name'],
    lastName: out['last-name'],
  };
}

async function main() {
  const args = parseArgs();
  if (args.password.length < 12) {
    // eslint-disable-next-line no-console
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.name, args.hospital),
  });
  if (!hospital) {
    // eslint-disable-next-line no-console
    console.error(`Hospital "${args.hospital}" not found. Check the exact name.`);
    process.exit(1);
  }

  const existing = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${args.email})`,
  });
  if (existing) {
    // eslint-disable-next-line no-console
    console.error(`User ${args.email} already exists (id=${existing.id}).`);
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
    hospitalId: hospital.id,
  });
  // eslint-disable-next-line no-console
  console.log(`Created ${args.role} ${args.email} for ${hospital.name} (id=${id}).`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
