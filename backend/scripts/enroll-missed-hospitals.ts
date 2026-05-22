/**
 * One-off cleanup: flip three hospitals from `eligible_to_enroll` to `enrolled`.
 *
 * These hospitals were auto-enrolled (db:enroll defaults to eligible_to_enroll)
 * but their enrollment-form rows weren't processed in the PM import (some weren't
 * in the workbook, Southwest's row erred on a track discrepancy). They are
 * confirmed enrolled per their initiative PMs.
 *
 * Idempotent: re-runs detect already-enrolled state and exit cleanly.
 *
 * Usage:
 *   tsx scripts/enroll-missed-hospitals.ts
 *   tsx scripts/enroll-missed-hospitals.ts --dry-run
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

interface TargetHospital {
  name: string;
  initiativeCode: 'SOAR' | 'TTT' | 'SPARK' | 'NEST';
  /** active or sustainability — used to pick the right cohort if hospital is in multiple. */
  track: 'active' | 'sustainability';
}

const TARGETS: TargetHospital[] = [
  { name: 'Southwest Health System, Inc.', initiativeCode: 'SOAR', track: 'active' },
  { name: 'Valley View Hospital', initiativeCode: 'SOAR', track: 'active' },
  // Note: Intermountain Health Good Samaritan Hospital was previously listed
  // here but TTT PM confirmed they are NOT participating in TTT for 2026.
  // See scripts/remove-misenrolled.ts and the updated hospitals_master_2026.json.
];

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Flipping eligible_to_enroll → enrolled${dryRun ? ' (dry run)' : ''}\n`);

  const initiatives = await db.select().from(schema.initiatives);
  const initiativeByCode = new Map(initiatives.map((i) => [i.code, i.id]));

  for (const t of TARGETS) {
    const initiativeId = initiativeByCode.get(t.initiativeCode);
    if (!initiativeId) {
      // eslint-disable-next-line no-console
      console.error(`  Initiative ${t.initiativeCode} not in DB. Skip.`);
      continue;
    }

    // Find hospital — try exact name match, falling back to fuzzy if needed
    const hospital = await db.query.hospitals.findFirst({
      where: eq(schema.hospitals.name, t.name),
    });
    if (!hospital) {
      // eslint-disable-next-line no-console
      console.error(`  Hospital "${t.name}" not found. Skip.`);
      continue;
    }

    // Find the matching enrollment via cohort
    const cohorts = await db
      .select()
      .from(schema.cohorts)
      .where(and(eq(schema.cohorts.initiativeId, initiativeId), eq(schema.cohorts.track, t.track)));
    let enrollment: typeof schema.enrollments.$inferSelect | null = null;
    for (const c of cohorts) {
      const e = await db.query.enrollments.findFirst({
        where: and(
          eq(schema.enrollments.hospitalId, hospital.id),
          eq(schema.enrollments.cohortId, c.id),
        ),
      });
      if (e) {
        enrollment = e;
        break;
      }
    }
    if (!enrollment) {
      // eslint-disable-next-line no-console
      console.error(
        `  No ${t.initiativeCode}/${t.track} enrollment for ${t.name}. ` +
          `Run db:enroll (or fix-southwest-soar-track.ts) first.`,
      );
      continue;
    }

    if (enrollment.status === 'enrolled') {
      // eslint-disable-next-line no-console
      console.log(`  ${t.name} (${t.initiativeCode}/${t.track}) already enrolled. Skip.`);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(
      `  ${t.name} (${t.initiativeCode}/${t.track}): "${enrollment.status}" → "enrolled"`,
    );
    if (!dryRun) {
      await db
        .update(schema.enrollments)
        .set({
          status: 'enrolled',
          updatedAt: new Date(),
          notes:
            (enrollment.notes ? enrollment.notes + '\n' : '') +
            `${new Date().toISOString().slice(0, 10)}: Confirmed enrolled per ${t.initiativeCode} PM; status corrected via enroll-missed-hospitals.ts.`,
        })
        .where(eq(schema.enrollments.id, enrollment.id));
    }
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
