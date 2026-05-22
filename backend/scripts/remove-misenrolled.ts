/**
 * One-off cleanup: hospitals that were auto-enrolled into an initiative based
 * on the CHA master list but aren't actually participating. The PM confirmed
 * the hospital should not be on the roster at all (not a track correction —
 * a "never should have been enrolled" correction).
 *
 * For each target:
 *   1. Find the hospital and the matching enrollment.
 *   2. Delete the enrollment row. CASCADE handles program_years, task_instances,
 *      and attachments. Nothing manually-entered exists (these enrollments have
 *      only auto-generated TaskInstances).
 *
 * The corresponding `data/hospitals_master_2026.json` row should also have
 * `participation.<initiative>.participating = false` so future `db:enroll`
 * runs don't re-create the enrollment.
 *
 * Idempotent: re-runs detect the deleted enrollment is gone and exit cleanly.
 *
 * Usage:
 *   tsx scripts/remove-misenrolled.ts
 *   tsx scripts/remove-misenrolled.ts --dry-run
 */
import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

interface Target {
  hospitalName: string;
  initiativeCode: 'TTT' | 'SPARK' | 'SOAR' | 'NEST';
  track: 'active' | 'sustainability';
  reason: string;
}

const TARGETS: Target[] = [
  {
    hospitalName: 'Intermountain Health Good Samaritan Hospital',
    initiativeCode: 'TTT',
    track: 'active',
    reason: 'Not actually participating in TTT for 2026 per TTT PM (CHA master list had stale participation flag).',
  },
];

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Removing mis-enrolled hospitals${dryRun ? ' (dry run)' : ''}…\n`);

  const initiatives = await db.select().from(schema.initiatives);
  const initiativeByCode = new Map(initiatives.map((i) => [i.code, i.id]));

  for (const t of TARGETS) {
    const initiativeId = initiativeByCode.get(t.initiativeCode);
    if (!initiativeId) {
      // eslint-disable-next-line no-console
      console.error(`  Initiative ${t.initiativeCode} not in DB. Skip.`);
      continue;
    }

    const hospital = await db.query.hospitals.findFirst({
      where: eq(schema.hospitals.name, t.hospitalName),
    });
    if (!hospital) {
      // eslint-disable-next-line no-console
      console.error(`  Hospital "${t.hospitalName}" not found. Skip.`);
      continue;
    }

    // Find the enrollment via cohort matching initiative + track
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
      console.log(
        `  ${t.hospitalName} / ${t.initiativeCode}/${t.track}: no enrollment found (already removed or never created). Skip.`,
      );
      continue;
    }

    // Count what will be cascaded — for the log message.
    const programYears = await db
      .select({ id: schema.programYears.id, year: schema.programYears.year })
      .from(schema.programYears)
      .where(eq(schema.programYears.enrollmentId, enrollment.id));
    const taskInstanceCount = (
      await db
        .select({ id: schema.taskInstances.id })
        .from(schema.taskInstances)
        .where(eq(schema.taskInstances.enrollmentId, enrollment.id))
    ).length;

    // eslint-disable-next-line no-console
    console.log(
      `  ${t.hospitalName} / ${t.initiativeCode}/${t.track} (enrollment ${enrollment.id})`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `    will cascade: ${programYears.length} program_year row(s) [${programYears.map((p) => p.year).join(', ')}], ${taskInstanceCount} task instance(s)`,
    );
    // eslint-disable-next-line no-console
    console.log(`    reason: ${t.reason}`);

    if (dryRun) continue;

    await db.delete(schema.enrollments).where(eq(schema.enrollments.id, enrollment.id));
    // eslint-disable-next-line no-console
    console.log(`    Deleted.\n`);
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
