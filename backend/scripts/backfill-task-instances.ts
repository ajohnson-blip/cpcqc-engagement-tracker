/**
 * Backfill missing TaskInstances for existing enrollments.
 *
 * Why this exists: `import-task-templates` adds new TaskTemplate rows but does
 * not automatically generate TaskInstance rows for hospitals that were enrolled
 * before the new templates existed. When we add a template (like the HRA tasks
 * for active cohorts, or a new Q1 advising for SOAR sustainability), existing
 * enrollments need a backfill pass.
 *
 * For each enrollment:
 *   - Look up matching task templates (by initiative + track)
 *   - For each program year of the enrollment, ensure a TaskInstance exists
 *     per (template, year). Existing instances are left alone; missing ones
 *     are created with status='not_started'.
 *
 * Idempotent: only inserts missing rows. Re-runs are a no-op.
 *
 * Usage:
 *   tsx scripts/backfill-task-instances.ts
 *   tsx scripts/backfill-task-instances.ts --dry-run
 */
import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import {
  computeDueDate,
  computePeriodString,
  type TemplatePeriod,
} from '../src/utils/period.js';
import {
  hraScheduleOverrideFor,
  scheduleHraInstances,
} from '../src/modules/compliance/hra.js';

const dryRun = process.argv.includes('--dry-run');

interface Stats {
  enrollmentsScanned: number;
  taskInstancesCreated: number;
  skippedExisting: number;
  skippedMalformedTemplate: number;
}

async function main() {
  const stats: Stats = {
    enrollmentsScanned: 0,
    taskInstancesCreated: 0,
    skippedExisting: 0,
    skippedMalformedTemplate: 0,
  };
  // eslint-disable-next-line no-console
  console.log(`Backfilling missing TaskInstances${dryRun ? ' (dry run)' : ''}…\n`);

  const enrollments = await db.select().from(schema.enrollments);
  for (const enrollment of enrollments) {
    stats.enrollmentsScanned += 1;

    // Cohort tells us initiative + track
    const cohort = await db.query.cohorts.findFirst({
      where: eq(schema.cohorts.id, enrollment.cohortId),
    });
    if (!cohort) continue;

    // Initiative code drives the per-year HRA schedule fallback.
    const init = await db.query.initiatives.findFirst({
      where: eq(schema.initiatives.id, cohort.initiativeId),
    });
    if (!init) continue;

    // Templates that should apply to this enrollment
    const templates = await db
      .select()
      .from(schema.taskTemplates)
      .where(
        and(
          eq(schema.taskTemplates.initiativeId, cohort.initiativeId),
          eq(schema.taskTemplates.track, cohort.track),
        ),
      );
    const hraTemplates = templates.filter((t) => t.taskType === 'readiness_assessment');

    // Program years already created for this enrollment
    const programYears = await db
      .select()
      .from(schema.programYears)
      .where(eq(schema.programYears.enrollmentId, enrollment.id));

    // Existing task instances (by (templateId, year)) we already have.
    const existing = await db
      .select({
        templateId: schema.taskInstances.taskTemplateId,
        programYearId: schema.taskInstances.programYearId,
      })
      .from(schema.taskInstances)
      .where(eq(schema.taskInstances.enrollmentId, enrollment.id));
    const existingKeys = new Set(existing.map((e) => `${e.templateId}::${e.programYearId}`));

    const toInsert: Array<typeof schema.taskInstances.$inferInsert> = [];

    for (const py of programYears) {
      // HRA due dates come from the program year's stored schedule (default Q1+Q4,
      // or an override like SPARK 2026's Q3+Q4), falling back to the per-year rule
      // for rows predating the hra_schedule column.
      const hraSchedule = py.hraSchedule ?? hraScheduleOverrideFor(init.code, py.year);
      const hraByTemplate = new Map(
        scheduleHraInstances(hraTemplates, py.year, hraSchedule).map((s) => [s.templateId, s]),
      );
      for (const template of templates) {
        const key = `${template.id}::${py.id}`;
        if (existingKeys.has(key)) {
          stats.skippedExisting += 1;
          continue;
        }
        let period: string;
        let dueOn: string;
        try {
          if (template.taskType === 'readiness_assessment') {
            const scheduled = hraByTemplate.get(template.id);
            if (!scheduled) throw new Error('HRA template missing from computed schedule');
            period = scheduled.period;
            dueOn = scheduled.dueOn;
          } else {
            period = computePeriodString(
              template.period as TemplatePeriod,
              template.periodLabel,
              py.year,
            );
            dueOn = computeDueDate(template.period as TemplatePeriod, template.periodLabel, py.year);
          }
        } catch {
          stats.skippedMalformedTemplate += 1;
          continue;
        }
        toInsert.push({
          id: uuid(),
          enrollmentId: enrollment.id,
          programYearId: py.id,
          taskTemplateId: template.id,
          period,
          dueOn,
          status: 'not_started',
        });
      }
    }

    if (toInsert.length === 0) continue;

    const hospital = await db.query.hospitals.findFirst({
      where: eq(schema.hospitals.id, enrollment.hospitalId),
    });
    // eslint-disable-next-line no-console
    console.log(
      `  + ${toInsert.length.toString().padStart(3, ' ')} for ${hospital?.name ?? '?'} / ${init.code} ${cohort.track}`,
    );

    stats.taskInstancesCreated += toInsert.length;
    if (!dryRun) {
      // Batched insert is fine — order doesn't matter for new rows.
      await db.insert(schema.taskInstances).values(toInsert);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nDone. Scanned ${stats.enrollmentsScanned} enrollment(s). ${
      dryRun ? 'Would create' : 'Created'
    } ${stats.taskInstancesCreated} TaskInstance(s). Skipped: ${stats.skippedExisting} existing, ${stats.skippedMalformedTemplate} malformed templates.`,
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
