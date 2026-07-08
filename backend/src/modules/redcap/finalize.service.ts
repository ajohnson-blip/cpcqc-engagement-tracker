/**
 * Finalize (lock) a month of REDCap-synced data-submission tasks. Once a period
 * is finalized, the sync leaves those tasks alone — no recompute, no overwrite —
 * so PMs don't have to re-review months they've already signed off on. Reversible.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';

export async function setPeriodFinalized(opts: {
  initiativeCode: 'SPARK' | 'NEST';
  period: string; // "2026-06" or "2026-Q2"
  finalize: boolean;
  actorUserId: string | null;
}): Promise<{ affected: number; finalized: boolean; finalizedBy: string | null }> {
  const init = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, opts.initiativeCode),
  });
  if (!init) throw new HttpError(404, `Initiative ${opts.initiativeCode} not found.`);

  const year = parseInt(opts.period.slice(0, 4), 10);
  if (!Number.isFinite(year)) throw new HttpError(400, `Malformed period "${opts.period}".`);

  // A friendly label for finalized_by (name, else email), resolved once.
  let byLabel: string | null = null;
  if (opts.finalize && opts.actorUserId) {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, opts.actorUserId) });
    byLabel = u ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email : opts.actorUserId;
  }

  const rows = await db
    .select({ id: schema.taskInstances.id })
    .from(schema.taskInstances)
    .innerJoin(schema.taskTemplates, eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId))
    .innerJoin(schema.programYears, eq(schema.programYears.id, schema.taskInstances.programYearId))
    .where(
      and(
        eq(schema.taskTemplates.initiativeId, init.id),
        eq(schema.taskTemplates.taskType, 'data_submission'),
        eq(schema.taskInstances.period, opts.period),
        eq(schema.programYears.year, year),
      ),
    );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { affected: 0, finalized: opts.finalize, finalizedBy: byLabel };

  const now = new Date();
  await db
    .update(schema.taskInstances)
    .set({
      finalizedAt: opts.finalize ? now : null,
      finalizedBy: opts.finalize ? byLabel : null,
      updatedAt: now,
    })
    .where(inArray(schema.taskInstances.id, ids));

  return { affected: ids.length, finalized: opts.finalize, finalizedBy: byLabel };
}
