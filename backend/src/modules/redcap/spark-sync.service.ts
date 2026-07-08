/**
 * SPARK REDCap sync. Pulls the quarterly_measures form straight from REDCap,
 * runs Luis Montes' engagement logic (ported in ./spark-engagement.ts), and
 * maps the result onto each SPARK-active hospital's quarterly data_submission
 * task instances.
 *
 * Policy (chosen by CPCQC):
 *   - Only a COMPLETE + ON-TIME submission counts toward the requirement
 *     (status=complete, outcome=on_time).
 *   - Complete but late  → complete / late (recorded, doesn't count).
 *   - Submitted but incomplete → needs_revision (recorded with missing fields,
 *     doesn't count until the gaps are filled).
 *   - No submission after the deadline → complete / not_submitted (documented miss).
 *   - No submission before the deadline → left untouched (not yet due).
 *
 * Always runnable as a dry-run (preview) — the staff UI previews first, then
 * applies. Re-running is idempotent: every cell is recomputed from REDCap.
 */
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { exportRecords } from './redcap.client.js';
import {
  buildSparkGrid,
  DEADLINES,
  type SparkCell,
  type MissingBySection,
} from './spark-engagement.js';
import { dispositionToTask, type SyncOverride, type SyncDisposition } from './sync-overrides.js';

/** A prior PM override recorded in a task's payload, if any. */
function readPriorOverride(
  ti: typeof schema.taskInstances.$inferSelect,
): { disposition: SyncDisposition; comment: string } | null {
  const ov = (ti.payload as { override?: { disposition?: SyncDisposition; comment?: string } } | null)
    ?.override;
  if (!ov?.disposition) return null;
  return { disposition: ov.disposition, comment: ov.comment ?? '' };
}

/**
 * REDCap SPARK Data Access Group → our canonical hospital name. Verified against
 * production: REDCap DAG labels differ from CHA canonical names (system prefixes,
 * "Medical Center"/"Interquest" suffixes), so we map deliberately rather than
 * fuzzy-match. The "test" DAG is ignored by the grid builder. If a hospital is
 * renamed, the sync reports it as unmapped and this constant is updated.
 */
export const SPARK_DAG_TO_HOSPITAL_NAME: Record<string, string> = {
  adventhealth_avist: 'AdventHealth Avista',
  denver_health: 'Denver Health Medical Center',
  east_morgan_county: 'East Morgan County Hospital',
  longmont_united_ho: 'CommonSpirit - Longmont United Hospital',
  mercy_hospital: 'CommonSpirit - Mercy Hospital',
  montrose_regional: 'Montrose Regional Health',
  parkview_medical_c: 'UCHealth Parkview Medical Center',
  san_luis_valley_he: 'San Luis Valley Health',
  st_anthony_summit: 'CommonSpirit - St. Anthony Summit Hospital',
  st_elizabeth_hospi: 'CommonSpirit - St. Elizabeth Hospital',
  st_francis_hospita: 'CommonSpirit - St. Francis Hospital - Interquest',
  st_thomas_more_hos: 'CommonSpirit - St. Thomas More Hospital',
  valley_view_hospit: 'Valley View Hospital',
  wray_community_dis: 'Wray Community District Hospital',
};

export type SparkSyncCategory =
  | 'counting' // complete + on-time → counts
  | 'complete_late' // complete but late → recorded, no count
  | 'complete_nodate' // complete, no @TODAY date → counts (timeliness N/A)
  | 'incomplete' // submitted but missing fields → needs_revision
  | 'not_submitted' // nothing by the deadline → documented miss
  | 'pending'; // nothing yet, but not yet due → left untouched

type TaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
type TaskOutcome = 'on_time' | 'late' | 'attended' | 'missed' | 'not_submitted' | null;

export interface SparkSyncRow {
  taskId: string;
  dagCode: string;
  hospitalId: string | null;
  hospitalName: string;
  quarter: string;
  category: SparkSyncCategory;
  /** True when a PM override (not the computed value) is being applied. */
  overridden: boolean;
  /** A prior manual override already stored on this task (preserved by the sync). */
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  submitted: boolean;
  complete: boolean;
  pctComplete: number | null;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  missingTotal: number;
  missingSummary: string | null;
  duplicateRecords: boolean;
  primaryRecordId: string | null;
  currentStatus: TaskStatus;
  currentOutcome: TaskOutcome;
  newStatus: TaskStatus;
  newOutcome: TaskOutcome;
  willChange: boolean;
  note: string;
}

export interface SparkSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  quartersInScope: string[];
  recordsFetched: number;
  rows: SparkSyncRow[];
  warnings: string[];
  counts: {
    willChange: number;
    counting: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    duplicates: number;
    unchanged: number;
  };
}

function missingSummary(m: MissingBySection): string | null {
  if (m.total === 0) return null;
  const parts: string[] = [];
  if (m.denom.length) parts.push(`denom ${m.denom.length}`);
  if (m.ssdoh.length) parts.push(`SSDoH ${m.ssdoh.length}`);
  if (m.pmhc.length) parts.push(`PMHC ${m.pmhc.length}`);
  if (m.ipv.length) parts.push(`IPV ${m.ipv.length}`);
  if (m.other.length) parts.push(`other ${m.other.length}`);
  return parts.join(', ');
}

interface Decision {
  category: SparkSyncCategory;
  status: TaskStatus;
  outcome: TaskOutcome;
  completedOn: string | null;
  leaveUntouched: boolean;
  note: string;
}

function decide(cell: SparkCell | undefined, quarter: string, today: string): Decision {
  const meta = DEADLINES[quarter];
  const deadline = meta?.deadline ?? null;
  const deadlinePassed = deadline ? today > deadline : false;

  if (!cell || !cell.submitted) {
    if (deadlinePassed) {
      return {
        category: 'not_submitted',
        status: 'complete',
        outcome: 'not_submitted',
        completedOn: null,
        leaveUntouched: false,
        note: `No REDCap submission; deadline ${deadline} has passed.`,
      };
    }
    return {
      category: 'pending',
      status: 'not_started',
      outcome: null,
      completedOn: null,
      leaveUntouched: true,
      note: deadline ? `Not yet submitted (due ${deadline}).` : 'Not yet submitted.',
    };
  }

  const dupSuffix = cell.duplicateRecords
    ? ` ⚠ ${cell.dataRecordIds.length} competing records — used ${cell.primaryRecordId}.`
    : '';
  const ms = missingSummary(cell.missing);

  if (cell.complete) {
    if (cell.onTime === true) {
      return {
        category: 'counting',
        status: 'complete',
        outcome: 'on_time',
        completedOn: cell.submissionDate,
        leaveUntouched: false,
        note: `Complete + on time (submitted ${cell.submissionDate}). Counts toward requirement.${dupSuffix}`,
      };
    }
    if (cell.onTime === false) {
      return {
        category: 'complete_late',
        status: 'complete',
        outcome: 'late',
        completedOn: cell.submissionDate,
        leaveUntouched: false,
        note: `Complete but LATE (submitted ${cell.submissionDate}, ${cell.daysFromDeadline} days past ${deadline}). Does not count.${dupSuffix}`,
      };
    }
    // Complete, no @TODAY date → timeliness N/A. Counts (outcome left null).
    return {
      category: 'complete_nodate',
      status: 'complete',
      outcome: null,
      completedOn: null,
      leaveUntouched: false,
      note: `Complete; no submission date in REDCap (timeliness N/A). Counts toward requirement.${dupSuffix}`,
    };
  }

  // Submitted but incomplete → recorded, does not count.
  const timing =
    cell.onTime === true
      ? 'on time'
      : cell.onTime === false
        ? `late (${cell.daysFromDeadline}d)`
        : 'no date';
  return {
    category: 'incomplete',
    status: 'needs_revision',
    outcome: cell.onTime === true ? 'on_time' : cell.onTime === false ? 'late' : null,
    completedOn: null,
    leaveUntouched: false,
    note: `Submitted (${timing}) but INCOMPLETE — ${cell.pctComplete}% complete, ${cell.missing.total} field(s) missing${ms ? ` (${ms})` : ''}. Does not count until complete.${dupSuffix}`,
  };
}

async function updateTaskInstance(
  ti: typeof schema.taskInstances.$inferSelect,
  patch: { status: TaskStatus; outcome: TaskOutcome; completedOn: string | null; note: string; payload: Record<string, unknown> },
  actorUserId: string | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(schema.taskInstances)
    .set({
      status: patch.status,
      outcome: patch.outcome,
      completedOn: patch.completedOn,
      staffNote: patch.note,
      payload: patch.payload,
      updatedBy: 'redcap-spark-sync',
      updatedAt: now,
    })
    .where(eq(schema.taskInstances.id, ti.id));

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId,
    actorRole: 'system_import',
    action: 'task.redcap_sync',
    entityType: 'task_instance',
    entityId: ti.id,
    diff: {
      from: { status: ti.status, outcome: ti.outcome },
      to: { status: patch.status, outcome: patch.outcome },
    },
    note: patch.note,
  });
}

export interface RunSparkSyncOptions {
  dryRun: boolean;
  programYear?: number;
  actorUserId?: string | null;
  /** PM overrides keyed by task instance id (apply only). */
  overrides?: Map<string, SyncOverride>;
}

export async function runSparkRedcapSync(opts: RunSparkSyncOptions): Promise<SparkSyncResult> {
  if (!env.REDCAP_SPARK_TOKEN) {
    throw new HttpError(
      400,
      'REDCAP_SPARK_TOKEN is not configured on the server. Add it as a Render environment variable.',
    );
  }

  const programYear = opts.programYear ?? 2026;
  const quartersInScope = [1, 2, 3, 4].map((q) => `${programYear}-Q${q}`);
  const today = new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();

  const records = await exportRecords({ token: env.REDCAP_SPARK_TOKEN, form: 'quarterly_measures' });
  const grid = buildSparkGrid(records);

  // Lookups.
  const hospitals = await db.select().from(schema.hospitals);
  const hospitalsByName = new Map(hospitals.map((h) => [h.name.toLowerCase(), h]));
  const spark = await db.query.initiatives.findFirst({ where: eq(schema.initiatives.code, 'SPARK') });
  if (!spark) throw new HttpError(500, 'SPARK initiative not found in the database.');

  // SPARK active cohorts covering the program year.
  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(and(eq(schema.cohorts.initiativeId, spark.id), eq(schema.cohorts.track, 'active')));
  const coveringCohorts = cohorts.filter((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return programYear >= start && programYear <= end;
  });

  const rows: SparkSyncRow[] = [];
  const warnings: string[] = [];

  // DAGs present in REDCap that we don't have a mapping for (besides 'test').
  const seenDags = new Set(
    records.map((r) => String(r['redcap_data_access_group'] ?? '').trim()).filter(Boolean),
  );
  for (const dag of seenDags) {
    if (dag === 'test') continue;
    if (!(dag in SPARK_DAG_TO_HOSPITAL_NAME)) {
      warnings.push(`REDCap DAG "${dag}" has data but is not mapped to a hospital — skipped.`);
    }
  }

  for (const [dag, hospitalName] of Object.entries(SPARK_DAG_TO_HOSPITAL_NAME)) {
    const hospital = hospitalsByName.get(hospitalName.toLowerCase());
    if (!hospital) {
      warnings.push(`Mapped hospital "${hospitalName}" (DAG ${dag}) not found in the tracker — skipped.`);
      continue;
    }

    // Resolve the SPARK-active enrollment for this hospital + program year.
    let enrollment: typeof schema.enrollments.$inferSelect | undefined;
    for (const c of coveringCohorts) {
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
      warnings.push(
        `${hospitalName} is in the SPARK REDCap project but has no SPARK-active enrollment for ${programYear} — skipped.`,
      );
      continue;
    }

    for (const quarter of quartersInScope) {
      const cell = grid.get(`${dag}::${quarter}`);

      // Find the quarterly data_submission task instance for this enrollment.
      const tiRows = await db
        .select({ ti: schema.taskInstances })
        .from(schema.taskInstances)
        .innerJoin(
          schema.taskTemplates,
          eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
        )
        .where(
          and(
            eq(schema.taskInstances.enrollmentId, enrollment.id),
            eq(schema.taskInstances.period, quarter),
            eq(schema.taskTemplates.taskType, 'data_submission'),
          ),
        )
        .limit(1);
      const ti = tiRows[0]?.ti;
      if (!ti) {
        // Only warn if there is actually data for this quarter we couldn't land.
        if (cell) {
          warnings.push(
            `${hospitalName} has REDCap data for ${quarter} but no matching data-submission task — skipped.`,
          );
        }
        continue;
      }

      const decision = decide(cell, quarter, today);
      const override = opts.overrides?.get(ti.id);
      const priorOverride = readPriorOverride(ti);

      // Precedence: a NEW override this session wins; otherwise a PRIOR manual
      // override is preserved (safeguard — the sync never recomputes over a
      // human decision); otherwise the computed value applies.
      let finalStatus: TaskStatus;
      let finalOutcome: TaskOutcome;
      let finalCompletedOn: string | null;
      let finalNote: string;
      if (override) {
        const t = dispositionToTask(override.disposition, cell?.submissionDate ?? null, today);
        finalStatus = t.status;
        finalOutcome = t.outcome;
        finalCompletedOn = t.completedOn;
        finalNote = override.comment.trim() || decision.note;
      } else if (priorOverride) {
        // Preserve the stored manual override untouched.
        finalStatus = ti.status;
        finalOutcome = ti.outcome;
        finalCompletedOn = ti.completedOn;
        finalNote = ti.staffNote ?? decision.note;
      } else if (decision.leaveUntouched) {
        finalStatus = ti.status;
        finalOutcome = ti.outcome;
        finalCompletedOn = ti.completedOn;
        finalNote = decision.note;
      } else {
        finalStatus = decision.status;
        finalOutcome = decision.outcome;
        finalCompletedOn = decision.completedOn;
        finalNote = decision.note;
      }

      const willChange =
        finalStatus !== ti.status ||
        finalOutcome !== ti.outcome ||
        (!!override && finalNote !== (ti.staffNote ?? ''));

      rows.push({
        taskId: ti.id,
        dagCode: dag,
        hospitalId: hospital.id,
        hospitalName,
        quarter,
        category: decision.category,
        overridden: !!override,
        priorOverride,
        submitted: cell?.submitted ?? false,
        complete: cell?.complete ?? false,
        pctComplete: cell ? cell.pctComplete : null,
        onTime: cell?.onTime ?? null,
        daysFromDeadline: cell?.daysFromDeadline ?? null,
        submissionDate: cell?.submissionDate ?? null,
        missingTotal: cell?.missing.total ?? 0,
        missingSummary: cell ? missingSummary(cell.missing) : null,
        duplicateRecords: cell?.duplicateRecords ?? false,
        primaryRecordId: cell?.primaryRecordId ?? null,
        currentStatus: ti.status,
        currentOutcome: ti.outcome,
        newStatus: finalStatus,
        newOutcome: finalOutcome,
        willChange,
        note: finalNote,
      });

      if (!opts.dryRun && willChange) {
        await updateTaskInstance(
          ti,
          {
            status: finalStatus,
            outcome: finalOutcome,
            completedOn: finalCompletedOn,
            note: finalNote,
            payload: {
              source: 'REDCap',
              event: quarter,
              quarter,
              submitted: cell?.submitted ?? false,
              complete: cell?.complete ?? false,
              pctComplete: cell?.pctComplete ?? null,
              onTime: cell?.onTime ?? null,
              daysFromDeadline: cell?.daysFromDeadline ?? null,
              submissionDate: cell?.submissionDate ?? null,
              missing: cell?.missing ?? null,
              primaryRecordId: cell?.primaryRecordId ?? null,
              duplicateRecords: cell?.duplicateRecords ?? false,
              dataRecordIds: cell?.dataRecordIds ?? [],
              syncedAt: fetchedAt,
              ...(override
                ? {
                    override: {
                      disposition: override.disposition,
                      comment: override.comment,
                      computedCategory: decision.category,
                      byUserId: opts.actorUserId ?? null,
                    },
                  }
                : {}),
            },
          },
          opts.actorUserId ?? null,
        );
      }
    }
  }

  const counts = {
    willChange: rows.filter((r) => r.willChange).length,
    counting: rows.filter((r) => r.category === 'counting' || r.category === 'complete_nodate').length,
    completeLate: rows.filter((r) => r.category === 'complete_late').length,
    incomplete: rows.filter((r) => r.category === 'incomplete').length,
    notSubmitted: rows.filter((r) => r.category === 'not_submitted').length,
    pending: rows.filter((r) => r.category === 'pending').length,
    duplicates: rows.filter((r) => r.duplicateRecords).length,
    unchanged: rows.filter((r) => !r.willChange).length,
  };

  logger.info(
    { dryRun: opts.dryRun, programYear, recordsFetched: records.length, ...counts },
    'SPARK REDCap sync complete',
  );

  return {
    dryRun: opts.dryRun,
    fetchedAt,
    programYear,
    quartersInScope,
    recordsFetched: records.length,
    rows,
    warnings,
    counts,
  };
}
