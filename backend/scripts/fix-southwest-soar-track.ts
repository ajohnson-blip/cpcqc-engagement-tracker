/**
 * One-off cleanup: hospitals that were auto-enrolled into SOAR sustainability
 * (based on the CHA master list's `status2026: "Sustainable"` value) but are
 * actually on SOAR active for 2026 per their SOAR PM. Currently:
 *   - Southwest Health System, Inc.
 *
 * (Valley View Hospital was originally in this list but was later corrected
 * back to SOAR sustainability per the SOAR PM — see migration
 * 0008_withdraw_valley_view_soar_active.sql.)
 *
 * For each hospital:
 *   1. DELETE the existing SOAR sustainability enrollment (and its program
 *      year + task instances via CASCADE). Hospitals can't withdraw per CPCQC
 *      policy, so the wrong row shouldn't linger as a soft-deleted ghost
 *      duplicate — it just gets removed.
 *   2. Create a fresh SOAR active enrollment for 2026 via the standard service
 *      (auto-generates the right TaskInstances).
 *
 * Idempotent: re-runs detect already-active enrollments and exit cleanly per
 * hospital.
 *
 * Usage:
 *   tsx scripts/fix-southwest-soar-track.ts
 *   tsx scripts/fix-southwest-soar-track.ts --dry-run
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { createEnrollment } from '../src/modules/enrollments/enrollments.service.js';

/**
 * Hospitals that were auto-enrolled to SOAR sustainability based on the CHA
 * master list, but their SOAR PM confirmed they should be on SOAR active for
 * 2026. The script withdraws the wrong enrollment and creates the right one
 * for each.
 */
const HOSPITAL_NAMES = [
  'Southwest Health System, Inc.',
];
const PROGRAM_YEAR = 2026;
const dryRun = process.argv.includes('--dry-run');

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Fixing SOAR active-track mis-enrollments${dryRun ? ' (dry run)' : ''}…`);

  for (const hospitalName of HOSPITAL_NAMES) {
    await fixOne(hospitalName);
  }
}

async function fixOne(hospitalName: string) {
  // 1. Find hospital
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.name, hospitalName),
  });
  if (!hospital) {
    // eslint-disable-next-line no-console
    console.error(`\nHospital "${hospitalName}" not found. Skipping.`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${hospital.name} (${hospital.id}):`);

  // 2. Find SOAR cohorts (active + sustainability) for 2026
  const soar = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, 'SOAR'),
  });
  if (!soar) throw new Error('SOAR initiative not found in DB.');

  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(eq(schema.cohorts.initiativeId, soar.id));
  const target = cohorts.find((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return c.track === 'active' && PROGRAM_YEAR >= start && PROGRAM_YEAR <= end;
  });
  const wrong = cohorts.find((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return c.track === 'sustainability' && PROGRAM_YEAR >= start && PROGRAM_YEAR <= end;
  });
  if (!target) throw new Error('No SOAR active 2026 cohort found.');
  if (!wrong) throw new Error('No SOAR sustainability 2026 cohort found.');
  // eslint-disable-next-line no-console
  console.log(`  Target (active) cohort:        ${target.label} (${target.id})`);
  // eslint-disable-next-line no-console
  console.log(`  Existing (sustainability) cohort: ${wrong.label} (${wrong.id})`);

  // 3. Look for existing SOAR active enrollment (idempotency).
  const alreadyActive = await db.query.enrollments.findFirst({
    where: and(
      eq(schema.enrollments.hospitalId, hospital.id),
      eq(schema.enrollments.cohortId, target.id),
    ),
  });
  if (alreadyActive) {
    // eslint-disable-next-line no-console
    console.log(`  Already has SOAR active enrollment ${alreadyActive.id} (status: ${alreadyActive.status}). Nothing to do.`);
    return;
  }

  // 4. Find existing SOAR sustainability enrollment.
  const existingSust = await db.query.enrollments.findFirst({
    where: and(
      eq(schema.enrollments.hospitalId, hospital.id),
      eq(schema.enrollments.cohortId, wrong.id),
    ),
  });
  if (existingSust) {
    // eslint-disable-next-line no-console
    console.log(`  Deleting wrong sustainability enrollment ${existingSust.id}…`);
    if (!dryRun) {
      await db
        .delete(schema.enrollments)
        .where(eq(schema.enrollments.id, existingSust.id));
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('  No existing sustainability enrollment found (already cleaned up?).');
  }

  // 5. Create the SOAR active enrollment.
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log('  Would create new SOAR active enrollment.');
    return;
  }
  const result = await createEnrollment({
    hospitalId: hospital.id,
    cohortId: target.id,
  });
  // eslint-disable-next-line no-console
  console.log(`  Created SOAR active enrollment ${result.enrollmentId}.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
