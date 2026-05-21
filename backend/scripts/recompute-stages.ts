/**
 * Sync every enrollment's `current_stage_id` to whatever the calendar +
 * enrollment-form completion says it should be (see stage-resolver.ts).
 *
 * Stage progression is date-driven:
 *   - No 2026 program year? → Enrollment
 *   - 2026 Enrollment Form incomplete? → Enrollment
 *   - Otherwise → Implementation Q{quarter-of-today} (or Sustainability Qx)
 *
 * Annual requirements are judged retrospectively — stages never penalize a
 * hospital for being behind on tasks within the current quarter.
 *
 * Usage:
 *   npm run db:recompute-stages
 *   npm run db:recompute-stages -- --dry-run
 */
import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { computeCurrentStageForEnrollment } from '../src/modules/stages/stage-resolver.js';

function parseArgs() {
  return { dryRun: process.argv.includes('--dry-run') };
}

async function main() {
  const { dryRun } = parseArgs();
  // eslint-disable-next-line no-console
  console.log(`Recomputing enrollment stages (date-driven)${dryRun ? ' [dry run]' : ''}…`);

  const enrollments = await db.select().from(schema.enrollments);
  const now = new Date();
  let changed = 0;
  let unchanged = 0;

  for (const e of enrollments) {
    const resolved = await computeCurrentStageForEnrollment(e.id, now);
    if (!resolved) continue;
    if (resolved.stageId === e.currentStageId) {
      unchanged += 1;
      continue;
    }

    if (dryRun) {
      const currentName = await stageName(e.currentStageId);
      // eslint-disable-next-line no-console
      console.log(
        `  Would change enrollment ${e.id}: "${currentName}" → "${resolved.stageName}" ` +
          `(EF complete: ${resolved.enrollmentFormComplete}, quarter: ${resolved.quarter ?? '—'})`,
      );
      changed += 1;
      continue;
    }

    await db
      .update(schema.enrollments)
      .set({ currentStageId: resolved.stageId, updatedAt: new Date() })
      .where(eq(schema.enrollments.id, e.id));
    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId: null,
      actorRole: 'system_recompute',
      action: 'enrollment.stage_changed',
      entityType: 'enrollment',
      entityId: e.id,
      diff: { to: { currentStageId: resolved.stageId } },
      note: `Recomputed (date-driven): stage → "${resolved.stageName}", EF complete: ${resolved.enrollmentFormComplete}, quarter: ${resolved.quarter ?? 'n/a'}`,
    });
    changed += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${dryRun ? 'Would change' : 'Changed'} ${changed} of ${enrollments.length} enrollments. ` +
      `${unchanged} were already correct.`,
  );
}

async function stageName(id: string | null): Promise<string> {
  if (!id) return '(none)';
  const rows = await db.select().from(schema.stages).where(eq(schema.stages.id, id)).limit(1);
  return rows[0]?.name ?? '(unknown)';
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
