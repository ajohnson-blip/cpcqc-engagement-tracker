/**
 * One-off cleanup: drop hospital_staff_members rows where the name field is
 * itself an email address — leftovers from a window where the PM-workbook
 * importer (scripts/import-pm-engagement-data.ts) used the wrong column layout
 * for the TTT workbook (14-col Clinical Lead / QI Champion / Primary Contact
 * vs the 19-col layout it assumed). Names landed in email columns and emails
 * landed in name columns, so the staff-roster upsert created rows like:
 *
 *   name  = "lauren.kauvar@adventhealth.com"
 *   role  = (garbled)
 *   email = (a real person's name, or null)
 *
 * Re-running the fixed importer (commits 36ebc66 / 5bb5628) inserts new,
 * correct rows but doesn't recognize these as the same person — the
 * lower(name)=lower(name) upsert key misses, so they linger as orphans next
 * to the correct rows in the hospital-detail roster view.
 *
 * Scope: TTT only. The SOAR/SPARK/NEST workbook used the matching 19-col
 * layout, so its old imports got names right (only emails were garbled
 * "[object Object]") — re-import there matches on name and updates in
 * place, so no cleanup is needed.
 *
 * Idempotent: deletes by id; re-runs find nothing.
 *
 * Usage:
 *   tsx scripts/cleanup-broken-ttt-staff-roster.ts            # delete
 *   tsx scripts/cleanup-broken-ttt-staff-roster.ts --dry-run  # list only
 */
import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

const dryRun = process.argv.includes('--dry-run');

// Conservative shape: at least one non-space, '@', non-space, '.', non-space.
// Targets real-looking emails; won't false-positive on a stage name like
// "DJ Snake" but also won't false-positive on actual human names that happen
// to contain '@' (we double-check via this regex after the SQL pre-filter).
const EMAIL_RE = /^\S+@\S+\.\S+$/;

async function main() {
  // eslint-disable-next-line no-console
  console.log(
    `Scanning hospital_staff_members for TTT rows where name is an email${
      dryRun ? ' (dry run)' : ''
    }...\n`,
  );

  const ttt = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, 'TTT'),
  });
  if (!ttt) {
    // eslint-disable-next-line no-console
    console.error('No TTT initiative row found — has db:seed run?');
    process.exit(1);
  }

  // SQL pre-filter for rows with '@' in name; final filter in JS against the
  // email regex keeps the SQL portable and the matching explicit.
  const candidates = await db
    .select()
    .from(schema.hospitalStaffMembers)
    .where(
      and(
        eq(schema.hospitalStaffMembers.initiativeId, ttt.id),
        sql`${schema.hospitalStaffMembers.name} LIKE '%@%'`,
      ),
    );
  const targets = candidates.filter((r) => EMAIL_RE.test(r.name));

  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.log('Nothing to clean up.');
    return;
  }

  // Look up hospital names for readable output.
  const hospitalIds = Array.from(new Set(targets.map((t) => t.hospitalId)));
  const hospitals = await db
    .select({ id: schema.hospitals.id, name: schema.hospitals.name })
    .from(schema.hospitals)
    .where(inArray(schema.hospitals.id, hospitalIds));
  const hospitalNameById = new Map(hospitals.map((h) => [h.id, h.name]));

  // eslint-disable-next-line no-console
  console.log(`Found ${targets.length} TTT staff row(s) with email-as-name:\n`);
  for (const t of targets) {
    const hospName = hospitalNameById.get(t.hospitalId) ?? '(unknown hospital)';
    // eslint-disable-next-line no-console
    console.log(
      `  ${hospName}\n    name=${JSON.stringify(t.name)}  role=${JSON.stringify(
        t.role,
      )}  email=${JSON.stringify(t.email)}`,
    );
  }

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`\n(dry run — no rows deleted)`);
    return;
  }

  const ids = targets.map((t) => t.id);
  await db
    .delete(schema.hospitalStaffMembers)
    .where(inArray(schema.hospitalStaffMembers.id, ids));
  // eslint-disable-next-line no-console
  console.log(`\nDeleted ${targets.length} row(s).`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
