/**
 * One-off cleanup: set required_assessments = 2 for active-track cohorts.
 *
 * Originally seeded as 0 (we assumed HRAs were sustainability-only); we've
 * since learned that all four initiatives track HRAs (two per year, normally
 * Q1 + Q4; SPARK 2026's Q2 + Q4 timing lives in program_years.hra_schedule and
 * does not affect this count). The hospital portal dashboard renders the Readiness
 * Assessments tile only when thresholds.requiredAssessments > 0, so this
 * needs to flip to 2 across (a) the config table (for future enrollments)
 * and (b) every existing active-track program_year row (so already-enrolled
 * hospitals start seeing the tile too).
 *
 * Idempotent: re-runs detect already-set values and skip.
 *
 * Usage:
 *   tsx scripts/fix-active-hra-thresholds.ts
 *   tsx scripts/fix-active-hra-thresholds.ts --dry-run
 */
import 'dotenv/config';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Setting required_assessments=2 for active cohorts${dryRun ? ' (dry run)' : ''}\n`);

  // 1. initiative_track_config: update all rows where track='active' and
  //    requiredAssessments != 2.
  const configRows = await db
    .select()
    .from(schema.initiativeTrackConfig)
    .where(eq(schema.initiativeTrackConfig.track, 'active'));
  let configsUpdated = 0;
  for (const c of configRows) {
    if (c.requiredAssessments === 2) continue;
    // eslint-disable-next-line no-console
    console.log(`  config: ${c.initiativeId} active  ${c.requiredAssessments} → 2`);
    configsUpdated += 1;
    if (!dryRun) {
      await db
        .update(schema.initiativeTrackConfig)
        .set({ requiredAssessments: 2, updatedAt: new Date() })
        .where(eq(schema.initiativeTrackConfig.id, c.id));
    }
  }

  // 2. program_years: update active enrollments' rows where requiredAssessments != 2.
  //    Join through cohorts to find active-track program_years.
  const pyRows = await db
    .select({
      pyId: schema.programYears.id,
      enrollmentId: schema.programYears.enrollmentId,
      year: schema.programYears.year,
      requiredAssessments: schema.programYears.requiredAssessments,
      track: schema.cohorts.track,
    })
    .from(schema.programYears)
    .innerJoin(schema.enrollments, eq(schema.enrollments.id, schema.programYears.enrollmentId))
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .where(
      and(
        eq(schema.cohorts.track, 'active'),
        ne(schema.programYears.requiredAssessments, 2),
      ),
    );
  // eslint-disable-next-line no-console
  console.log(`\n  program_years to update: ${pyRows.length} (active-track, requiredAssessments != 2)\n`);
  if (!dryRun && pyRows.length > 0) {
    for (const py of pyRows) {
      await db
        .update(schema.programYears)
        .set({ requiredAssessments: 2, updatedAt: new Date() })
        .where(eq(schema.programYears.id, py.pyId));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nSummary:\n  configs updated:       ${configsUpdated}\n  program_years updated: ${pyRows.length}` +
      (dryRun ? '  (dry run)' : ''),
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
