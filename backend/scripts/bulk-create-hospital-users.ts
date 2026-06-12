/**
 * Bulk-create hospital portal accounts from the hospital_staff_members roster.
 *
 * One account per distinct (lowercased) email in the roster, role
 * hospital_admin, tied to the hospital on that roster row. Generates a strong
 * unique temporary password per user and writes a credentials CSV to disk for
 * the operator to distribute. Users rotate the temp password via Account →
 * Change password.
 *
 * Idempotent: emails that already have a user are skipped, so re-runs only
 * create the gaps. The unique index on lower(email) is the backstop.
 *
 * Edge cases handled:
 *   - Invalid / missing emails are skipped and counted.
 *   - An email appearing at >1 hospital (regional staff) gets ONE account,
 *     tied to the alphabetically-first hospital, and is flagged in the CSV +
 *     summary so the operator knows that person can only see one site.
 *   - Names are split first / rest; a leading "Dr." is stripped.
 *
 * SECURITY: the output CSV contains plaintext temp passwords. It is written
 * outside source control; do NOT commit it. Distribute over a secure channel
 * and delete it afterward.
 *
 * Usage (run from backend/, with prod env):
 *   NODE_ENV=production DATABASE_URL=... \
 *     npx tsx scripts/bulk-create-hospital-users.ts --out=../cpcqc-credentials.csv
 *   ... add --dry-run to preview without writing anything.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { v4 as uuid } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

const dryRun = process.argv.includes('--dry-run');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg ? outArg.slice('--out='.length) : '../cpcqc-credentials.csv';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Unambiguous charset (no 0/O/1/l/I) so temp passwords survive being read off
// a screen / pasted from a CSV. 16 chars ≈ 94 bits of entropy.
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(len = 16): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PW_CHARS[bytes[i]! % PW_CHARS.length];
  return out;
}

function splitName(raw: string): { first: string; last: string } {
  const cleaned = raw.replace(/^\s*Dr\.?\s+/i, '').trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length <= 1) return { first: cleaned, last: '' };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

function csvCell(v: string): string {
  // Quote if it contains comma/quote/newline; double internal quotes.
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Bulk-creating hospital users${dryRun ? ' (DRY RUN)' : ''}…\n`);

  // Roster rows with a usable email, joined to hospital name.
  const rows = await db
    .select({
      name: schema.hospitalStaffMembers.name,
      email: schema.hospitalStaffMembers.email,
      hospitalId: schema.hospitalStaffMembers.hospitalId,
      hospitalName: schema.hospitals.name,
    })
    .from(schema.hospitalStaffMembers)
    .innerJoin(
      schema.hospitals,
      eq(schema.hospitals.id, schema.hospitalStaffMembers.hospitalId),
    );

  // Existing users — skip any email already present.
  const existing = await db
    .select({ email: sql<string>`lower(${schema.users.email})` })
    .from(schema.users);
  const existingEmails = new Set(existing.map((e) => e.email));

  // Dedupe roster by lowercased email; collect all hospitals seen per email.
  interface Candidate {
    email: string; // lowercased
    name: string;
    hospitals: Array<{ id: string; name: string }>;
  }
  const byEmail = new Map<string, Candidate>();
  let invalidEmailRows = 0;
  for (const r of rows) {
    const email = (r.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalidEmailRows += 1;
      continue;
    }
    const entry = byEmail.get(email);
    if (entry) {
      if (!entry.hospitals.some((h) => h.id === r.hospitalId)) {
        entry.hospitals.push({ id: r.hospitalId, name: r.hospitalName });
      }
    } else {
      byEmail.set(email, {
        email,
        name: r.name,
        hospitals: [{ id: r.hospitalId, name: r.hospitalName }],
      });
    }
  }

  const toCreate: Candidate[] = [];
  let skippedExisting = 0;
  for (const cand of byEmail.values()) {
    if (existingEmails.has(cand.email)) {
      skippedExisting += 1;
      continue;
    }
    toCreate.push(cand);
  }

  // Stable order; for multi-hospital, assign the alphabetically-first hospital.
  toCreate.sort((a, b) => a.email.localeCompare(b.email));

  const csvLines: string[] = [
    ['email', 'first_name', 'last_name', 'role', 'hospital', 'temp_password', 'note']
      .map(csvCell)
      .join(','),
  ];
  let created = 0;
  let multiHospital = 0;

  for (const cand of toCreate) {
    const hospitals = [...cand.hospitals].sort((a, b) => a.name.localeCompare(b.name));
    const assigned = hospitals[0]!;
    const isMulti = hospitals.length > 1;
    if (isMulti) multiHospital += 1;
    const { first, last } = splitName(cand.name);
    const password = generatePassword();
    const note = isMulti
      ? `Regional staff — also on roster at: ${hospitals.slice(1).map((h) => h.name).join('; ')}. Account tied to ${assigned.name} only.`
      : '';

    if (!dryRun) {
      const passwordHash = await hashPassword(password);
      await db.insert(schema.users).values({
        id: uuid(),
        email: cand.email,
        passwordHash,
        firstName: first || null,
        lastName: last || null,
        role: 'hospital_admin',
        hospitalId: assigned.id,
      });
    }
    created += 1;
    csvLines.push(
      [cand.email, first, last, 'hospital_admin', assigned.name, password, note]
        .map(csvCell)
        .join(','),
    );
  }

  if (!dryRun) {
    writeFileSync(outPath, csvLines.join('\n') + '\n', { mode: 0o600 });
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      `Distinct valid roster emails: ${byEmail.size}`,
      `Already had an account (skipped): ${skippedExisting}`,
      `Roster rows with invalid/missing email (skipped): ${invalidEmailRows}`,
      `${dryRun ? 'Would create' : 'Created'}: ${created}`,
      `  of which multi-hospital (flagged): ${multiHospital}`,
      dryRun
        ? '\n(dry run — no users inserted, no CSV written)'
        : `\nCredentials CSV written to: ${outPath}  (chmod 600)\n` +
          'SECURITY: contains plaintext temp passwords. Distribute securely and delete after.',
    ].join('\n'),
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
