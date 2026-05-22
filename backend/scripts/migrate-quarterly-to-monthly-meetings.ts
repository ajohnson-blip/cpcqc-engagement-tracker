/**
 * Migrate meeting_attendance from quarterly to monthly granularity for active
 * cohorts (TTT, SPARK, SOAR active, NEST). Sustainability is untouched.
 *
 * Why: the original model had one quarterly task per active enrollment with a
 * payload array of monthly attendances. This made compliance counting unworkable
 * — max possible was 4 (one per quarter) but the requirement is ≥9 monthly
 * meetings per year. The new model has 12 monthly tasks per active enrollment.
 *
 * What this does:
 *   For each active enrollment:
 *     1. Read its existing quarterly meeting_attendance TaskInstances.
 *     2. For each completed quarterly TI, walk payload.attendances[] and mark
 *        the matching monthly TaskInstance complete with outcome='attended'.
 *     3. Delete the old quarterly TaskInstances.
 *   Finally:
 *     4. Delete the old quarterly meeting_attendance TaskTemplates (so they
 *        don't get used by future createEnrollment calls).
 *
 * Prereqs: db:import-templates and backfill-task-instances must have already
 * created the new monthly templates and TaskInstances (status=not_started).
 *
 * Idempotent: re-runs treat already-migrated quarterly TIs as a no-op.
 *
 * Usage:
 *   tsx scripts/migrate-quarterly-to-monthly-meetings.ts
 *   tsx scripts/migrate-quarterly-to-monthly-meetings.ts --dry-run
 */
import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

const dryRun = process.argv.includes('--dry-run');

const MONTH_TO_NUM: Record<string, string> = {
  January: '01', February: '02', March: '03', April: '04',
  May: '05', June: '06', July: '07', August: '08',
  September: '09', October: '10', November: '11', December: '12',
};

interface Attendance {
  meetingDate?: string;
  type?: string;
  notes?: string;
  source?: string;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Migrating quarterly meeting_attendance → monthly${dryRun ? ' (dry run)' : ''}\n`);

  // Find old quarterly meeting_attendance templates for active cohorts.
  // (Sustainability ones are left in place.)
  const oldTemplates = await db
    .select()
    .from(schema.taskTemplates)
    .where(
      and(
        eq(schema.taskTemplates.taskType, 'meeting_attendance'),
        eq(schema.taskTemplates.period, 'quarterly'),
        eq(schema.taskTemplates.track, 'active'),
      ),
    );
  if (oldTemplates.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No quarterly active-cohort meeting templates found. Already migrated?');
    return;
  }
  const oldTemplateIds = new Set(oldTemplates.map((t) => t.id));

  // Find new monthly meeting_attendance templates per initiative.
  // Key: `${initiativeId}::${periodLabel}` → template id.
  const newTemplates = await db
    .select()
    .from(schema.taskTemplates)
    .where(
      and(
        eq(schema.taskTemplates.taskType, 'meeting_attendance'),
        eq(schema.taskTemplates.period, 'monthly'),
        eq(schema.taskTemplates.track, 'active'),
      ),
    );
  if (newTemplates.length === 0) {
    throw new Error(
      'No monthly meeting_attendance templates exist yet. Run `npm run db:import-templates` first.',
    );
  }

  // Load all existing quarterly TaskInstances (for active tracks).
  const oldInstances = await db
    .select()
    .from(schema.taskInstances)
    .where(inArray(schema.taskInstances.taskTemplateId, [...oldTemplateIds]));
  // eslint-disable-next-line no-console
  console.log(`Found ${oldInstances.length} quarterly meeting_attendance instance(s) to migrate.\n`);

  // Pre-load all monthly TaskInstances so we can look them up by (enrollment, period).
  const monthlyInstances = await db
    .select()
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .where(
      and(
        eq(schema.taskTemplates.taskType, 'meeting_attendance'),
        eq(schema.taskTemplates.period, 'monthly'),
      ),
    );
  const monthlyByKey = new Map<string, typeof schema.taskInstances.$inferSelect>();
  for (const row of monthlyInstances) {
    const key = `${row.task_instances.enrollmentId}::${row.task_instances.period}`;
    monthlyByKey.set(key, row.task_instances);
  }

  let attendancesMigrated = 0;
  let monthlyMarkedComplete = 0;
  let missingMonthly = 0;
  let oldDeleted = 0;

  for (const oldTi of oldInstances) {
    const payload = (oldTi.payload as { attendances?: Attendance[] } | null) ?? {};
    const attendances = Array.isArray(payload.attendances) ? payload.attendances : [];

    for (const att of attendances) {
      if (!att.meetingDate) continue;
      const m = /^(\d{4})-(\d{2})/.exec(att.meetingDate);
      if (!m) continue;
      const period = `${m[1]}-${m[2]}`;
      const key = `${oldTi.enrollmentId}::${period}`;
      const monthly = monthlyByKey.get(key);
      if (!monthly) {
        missingMonthly += 1;
        continue;
      }
      attendancesMigrated += 1;
      if (monthly.status === 'complete' && monthly.outcome === 'attended') continue; // already migrated
      if (!dryRun) {
        const newPayload = { ...(monthly.payload as Record<string, unknown> | null ?? {}) };
        newPayload['meetingDate'] = att.meetingDate;
        if (att.type) newPayload['type'] = att.type;
        if (att.notes) newPayload['notes'] = att.notes;
        newPayload['source'] = 'quarterly-migration';
        await db
          .update(schema.taskInstances)
          .set({
            status: 'complete',
            outcome: 'attended',
            completedOn: att.meetingDate,
            payload: newPayload,
            updatedBy: 'migration',
            updatedAt: new Date(),
          })
          .where(eq(schema.taskInstances.id, monthly.id));
      }
      monthlyMarkedComplete += 1;
    }

    // Delete the old quarterly task instance.
    if (!dryRun) {
      await db.delete(schema.taskInstances).where(eq(schema.taskInstances.id, oldTi.id));
    }
    oldDeleted += 1;
  }

  // Delete the old quarterly meeting templates so they can't be recreated.
  if (!dryRun) {
    await db
      .delete(schema.taskTemplates)
      .where(inArray(schema.taskTemplates.id, [...oldTemplateIds]));
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nSummary:\n` +
      `  Attendances walked:    ${attendancesMigrated}\n` +
      `  Monthly tasks marked:  ${monthlyMarkedComplete}\n` +
      `  Missing monthly slots: ${missingMonthly}  (run backfill if non-zero)\n` +
      `  Old quarterly deleted: ${oldDeleted}\n` +
      `  Templates deleted:     ${oldTemplateIds.size}` +
      (dryRun ? ' (dry run — nothing written)' : ''),
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
