/**
 * NEST REDCap sync. Pulls the two monthly repeating forms (safe_sleep_audit +
 * chart_reviews) from REDCap, runs the NEST engagement logic (ported in
 * ./nest-engagement.ts), and maps the result onto each NEST-active hospital's
 * MONTHLY data_submission task instances.
 *
 * Policy (chosen by CPCQC — strict):
 *   - A month COUNTS toward the 9-of-12 requirement only when BOTH forms were
 *     submitted, EVERY row passes its completeness check, and it was on time
 *     (status=complete, outcome=on_time).
 *   - Complete but late → complete / late (recorded, doesn't count).
 *   - Submitted but not fully complete (any failing row, or only one form) →
 *     needs_revision (recorded, doesn't count until fixed).
 *   - Nothing by the deadline → complete / not_submitted (documented miss).
 *   - Nothing yet, deadline not passed → left untouched (pending).
 *
 * Dry-run previews; re-running is idempotent (recomputed from REDCap each time).
 */
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { exportRecords, exportMetadata } from './redcap.client.js';
import {
  buildNestGrid,
  monthDeadline,
  eventToPeriod,
  SSP_FORM,
  CHART_FORM,
  F_EVENT,
  F_REPEAT_INSTRUMENT,
  type NestCell,
} from './nest-engagement.js';
import {
  dispositionToTask,
  isHumanEdit,
  isoDate,
  periodEndIso,
  resolveDeadline,
  recomputeTimeliness,
  toIsoDateOrNull,
  type SyncOverride,
  type SyncDisposition,
} from './sync-overrides.js';

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
 * REDCap NEST Data Access Group → our canonical hospital name. Verified against
 * production (names differ from REDCap labels). `test`/`test_2` are ignored by
 * the grid builder. `vail_health` is intentionally absent — it has no DAG in the
 * NEST project and no NEST enrollment in the tracker.
 */
export const NEST_DAG_TO_HOSPITAL_NAME: Record<string, string> = {
  community_hospital: 'Community Hospital',
  denver_health: 'Denver Health Medical Center',
  good_samaritan_med: 'Intermountain Health Good Samaritan Hospital',
  montrose_regional: 'Montrose Regional Health',
  platte_valley_medi: 'Intermountain Health Platte Valley Hospital',
  saint_marys_hospit: 'Intermountain Health St. Mary’s Regional Hospital',
  st_francis_hospita: 'CommonSpirit - St. Francis Hospital - Interquest',
  valley_view_hospit: 'Valley View Hospital',
  wray_community_dis: 'Wray Community District Hospital',
};

export type NestSyncCategory =
  | 'counting'
  | 'complete_late'
  | 'complete_nodate'
  | 'incomplete'
  | 'not_submitted'
  | 'pending';

type TaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
type TaskOutcome = 'on_time' | 'late' | 'attended' | 'missed' | 'not_submitted' | null;

export interface NestSyncRow {
  taskId: string;
  dagCode: string;
  hospitalId: string | null;
  hospitalName: string;
  period: string; // "2026-03"
  category: NestSyncCategory;
  /** True when a PM override (not the computed value) is being applied. */
  overridden: boolean;
  /** A prior manual override already stored on this task (preserved by the sync). */
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  /** Finalized (locked): the sync leaves it alone; the preview shows it read-only. */
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  sspSubmitted: boolean;
  chartSubmitted: boolean;
  bothSubmitted: boolean;
  dataComplete: boolean;
  sspRows: number;
  sspComplete: number;
  chartRows: number;
  chartComplete: number;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  /** Incomplete rows grouped by REDCap record — which record is missing what.
   *  Empty unless the cell is incomplete. */
  incompleteRecords: Array<{
    recordId: string;
    form: string;
    fields: Array<{ field: string; label: string }>;
  }>;
  currentStatus: TaskStatus;
  currentOutcome: TaskOutcome;
  newStatus: TaskStatus;
  newOutcome: TaskOutcome;
  willChange: boolean;
  note: string;
}

export interface NestSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  periodsInScope: string[];
  recordsFetched: number;
  rows: NestSyncRow[];
  warnings: string[];
  counts: {
    willChange: number;
    counting: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    unchanged: number;
  };
}

interface Decision {
  category: NestSyncCategory;
  status: TaskStatus;
  outcome: TaskOutcome;
  completedOn: string | null;
  leaveUntouched: boolean;
  note: string;
}

function decide(cell: NestCell | undefined, deadline: string, today: string): Decision {
  const deadlinePassed = today > deadline;
  const anySubmitted = !!cell && (cell.ssp.submitted || cell.chart.submitted);

  if (!anySubmitted) {
    if (deadlinePassed) {
      return {
        category: 'not_submitted',
        status: 'complete',
        outcome: 'not_submitted',
        completedOn: null,
        leaveUntouched: false,
        note: `No NEST submission; deadline ${deadline} has passed.`,
      };
    }
    return {
      category: 'pending',
      status: 'not_started',
      outcome: null,
      completedOn: null,
      leaveUntouched: true,
      note: `Not yet submitted (due ${deadline}).`,
    };
  }

  const c = cell!;
  const date = c.earliestSubmissionDate;

  if (c.dataComplete) {
    if (c.onTime === true) {
      return {
        category: 'counting',
        status: 'complete',
        outcome: 'on_time',
        completedOn: date,
        leaveUntouched: false,
        note: `Both forms complete + on time (started ${date}). Counts toward requirement.`,
      };
    }
    if (c.onTime === false) {
      return {
        category: 'complete_late',
        status: 'complete',
        outcome: 'late',
        completedOn: date,
        leaveUntouched: false,
        note: `Both forms complete but LATE (${date}, ${c.daysFromDeadline} days past ${deadline}). Does not count.`,
      };
    }
    return {
      category: 'complete_nodate',
      status: 'complete',
      outcome: null,
      completedOn: null,
      leaveUntouched: false,
      note: `Both forms complete; no submission date (timeliness N/A). Counts toward requirement.`,
    };
  }

  // Submitted but not fully complete → needs_revision (does not count).
  let detail: string;
  if (!c.bothSubmitted) {
    detail = c.ssp.submitted
      ? 'only the SSP audit was submitted — chart review missing'
      : 'only the chart review was submitted — SSP audit missing';
  } else {
    detail = `SSP ${c.ssp.nComplete}/${c.ssp.nRows} + chart ${c.chart.nComplete}/${c.chart.nRows} rows complete — not all rows pass`;
  }
  const timing = c.onTime === true ? 'on time' : c.onTime === false ? `late (${c.daysFromDeadline}d)` : 'no date';
  return {
    category: 'incomplete',
    status: 'needs_revision',
    outcome: c.onTime === true ? 'on_time' : c.onTime === false ? 'late' : null,
    completedOn: null,
    leaveUntouched: false,
    note: `Submitted (${timing}) but INCOMPLETE — ${detail}. Does not count until complete.`,
  };
}


/**
 * Group a cell's incomplete rows by REDCap record, so staff can see whether one
 * record is missing several things or several records are each missing one.
 * The PMs asked for exactly that distinction: the first is an abandoned entry,
 * the second a scattered gap, and they warrant different conversations.
 */
function collectMissing(
  forms: Array<{ form: string; rollup: { incompleteRows: Array<{ recordId: string; missing: string[] }> } | undefined }>,
  labels: Map<string, string>,
): Array<{ recordId: string; form: string; fields: Array<{ field: string; label: string }> }> {
  const out: Array<{ recordId: string; form: string; fields: Array<{ field: string; label: string }> }> = [];
  for (const { form, rollup } of forms) {
    for (const r of rollup?.incompleteRows ?? []) {
      out.push({
        recordId: r.recordId,
        form,
        fields: r.missing.map((f) => ({ field: f, label: labels.get(f) ?? f })),
      });
    }
  }
  // Most-incomplete first: the records needing the most attention read first.
  return out.sort((a, b) => b.fields.length - a.fields.length || a.recordId.localeCompare(b.recordId));
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
      completedOn: toIsoDateOrNull(patch.completedOn),
      staffNote: patch.note,
      payload: patch.payload,
      updatedBy: 'redcap-nest-sync',
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

export interface RunNestSyncOptions {
  dryRun: boolean;
  programYear?: number;
  actorUserId?: string | null;
  /** PM overrides keyed by task instance id (apply only). */
  overrides?: Map<string, SyncOverride>;
}

export async function runNestRedcapSync(opts: RunNestSyncOptions): Promise<NestSyncResult> {
  if (!env.REDCAP_NEST_TOKEN) {
    throw new HttpError(
      400,
      'REDCAP_NEST_TOKEN is not configured on the server. Add it as a Render environment variable.',
    );
  }

  const programYear = opts.programYear ?? 2026;
  const today = new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();

  // Field labels from the live data dictionary; best-effort, since a missing
  // label only costs readability, not correctness.
  const fieldLabels = new Map<string, string>();
  try {
    const meta = await exportMetadata({ token: env.REDCAP_NEST_TOKEN });
    for (const m of meta) {
      const name = String(m['field_name'] ?? '').trim();
      const label = String(m['field_label'] ?? '').replace(/<[^>]*>/g, '').trim();
      if (name && label) fieldLabels.set(name, label);
    }
  } catch {
    /* labels are a convenience; variable names still identify the field */
  }

  const records = await exportRecords({
    token: env.REDCAP_NEST_TOKEN,
    forms: [SSP_FORM, CHART_FORM],
  });
  const grid = buildNestGrid(records);

  const hospitals = await db.select().from(schema.hospitals);
  const hospitalsByName = new Map(hospitals.map((h) => [h.name.toLowerCase(), h]));
  const nest = await db.query.initiatives.findFirst({ where: eq(schema.initiatives.code, 'NEST') });
  if (!nest) throw new HttpError(500, 'NEST initiative not found in the database.');

  // Per-period official deadline from the task due dates (CPCQC's sheet).
  const dueRows = await db
    .select({ period: schema.taskInstances.period, dueOn: schema.taskInstances.dueOn })
    .from(schema.taskInstances)
    .innerJoin(schema.taskTemplates, eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId))
    .innerJoin(schema.programYears, eq(schema.programYears.id, schema.taskInstances.programYearId))
    .where(
      and(
        eq(schema.taskTemplates.initiativeId, nest.id),
        eq(schema.taskTemplates.taskType, 'data_submission'),
        eq(schema.programYears.year, programYear),
      ),
    );
  const periodDueOn = new Map<string, string>();
  for (const r of dueRows) if (r.dueOn) periodDueOn.set(r.period, isoDate(r.dueOn));

  // Authoritative deadline for a month = the sheet's due_on (where it's a real,
  // later-than-month-end date), else the computed 2nd-Friday-of-next-month rule.
  const deadlineFor = (period: string, dueOn: string | Date | null): string =>
    resolveDeadline(dueOn, periodEndIso(period), monthDeadline(programYear, parseInt(period.slice(5), 10)));

  // Scope to months that are actionable: the official deadline has passed, or
  // there's data.
  const periodsInScope = Array.from({ length: 12 }, (_, i) => `${programYear}-${String(i + 1).padStart(2, '0')}`)
    .filter((period) => {
      const deadline = deadlineFor(period, periodDueOn.get(period) ?? null);
      const hasData = [...grid.keys()].some((k) => k.endsWith(`::${period}`));
      return today > deadline || hasData;
    });

  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(and(eq(schema.cohorts.initiativeId, nest.id), eq(schema.cohorts.track, 'active')));
  const coveringCohorts = cohorts.filter((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return programYear >= start && programYear <= end;
  });

  const rows: NestSyncRow[] = [];
  const warnings: string[] = [];

  // Safety net: a data row on either repeating form whose event maps to no month
  // is being SILENTLY DROPPED (the class of bug where SPARK's "aprjune" slug
  // wasn't recognized and all of Q2 vanished). Surface it instead of losing data.
  const unrecognizedEvents = new Set<string>();
  for (const r of records) {
    const instrument = String(r[F_REPEAT_INSTRUMENT] ?? '').trim();
    if (instrument !== SSP_FORM && instrument !== CHART_FORM) continue;
    const ev = String(r[F_EVENT] ?? '').trim();
    if (!ev || eventToPeriod(ev) !== null) continue;
    unrecognizedEvents.add(ev);
  }
  for (const ev of unrecognizedEvents) {
    warnings.push(
      `REDCap event "${ev}" has NEST data but isn't recognized as a month — its rows are being SKIPPED. The event→period mapping needs updating.`,
    );
  }

  const seenDags = new Set(
    records.map((r) => String(r['redcap_data_access_group'] ?? '').trim()).filter(Boolean),
  );
  for (const dag of seenDags) {
    if (dag === 'test' || dag === 'test_2') continue;
    if (!(dag in NEST_DAG_TO_HOSPITAL_NAME)) {
      warnings.push(`REDCap DAG "${dag}" has data but is not mapped to a hospital — skipped.`);
    }
  }

  for (const [dag, hospitalName] of Object.entries(NEST_DAG_TO_HOSPITAL_NAME)) {
    const hospital = hospitalsByName.get(hospitalName.toLowerCase());
    if (!hospital) {
      warnings.push(`Mapped hospital "${hospitalName}" (DAG ${dag}) not found in the tracker — skipped.`);
      continue;
    }

    let enrollment: typeof schema.enrollments.$inferSelect | undefined;
    for (const c of coveringCohorts) {
      const e = await db.query.enrollments.findFirst({
        where: and(eq(schema.enrollments.hospitalId, hospital.id), eq(schema.enrollments.cohortId, c.id)),
      });
      if (e) {
        enrollment = e;
        break;
      }
    }
    if (!enrollment) {
      warnings.push(
        `${hospitalName} is in the NEST REDCap project but has no NEST-active enrollment for ${programYear} — skipped.`,
      );
      continue;
    }

    for (const period of periodsInScope) {
      const cell = grid.get(`${dag}::${period}`);

      const tiRows = await db
        .select({ ti: schema.taskInstances })
        .from(schema.taskInstances)
        .innerJoin(schema.taskTemplates, eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId))
        .where(
          and(
            eq(schema.taskInstances.enrollmentId, enrollment.id),
            eq(schema.taskInstances.period, period),
            eq(schema.taskTemplates.taskType, 'data_submission'),
          ),
        )
        .limit(1);
      const ti = tiRows[0]?.ti;
      if (!ti) {
        if (cell) {
          warnings.push(`${hospitalName} has REDCap data for ${period} but no matching data-submission task — skipped.`);
        }
        continue;
      }

      // Authoritative deadline = this task's due_on (CPCQC sheet); recompute
      // timeliness against it, overriding the grid's own computation.
      const deadline = deadlineFor(period, ti.dueOn);
      const subDate = cell?.earliestSubmissionDate ?? null;
      const tl = recomputeTimeliness(subDate, deadline);
      const effCell = cell
        ? { ...cell, deadline, onTime: tl.onTime, daysFromDeadline: tl.daysFromDeadline }
        : undefined;

      if (cell?.invalidDate) {
        warnings.push(
          `${hospitalName} ${period}: a submission-date field isn't a valid date — timeliness may be affected. Fix the date in REDCap.`,
        );
      }

      const decision = decide(effCell, deadline, today);
      const override = opts.overrides?.get(ti.id);
      const priorOverride = readPriorOverride(ti);
      const finalized = ti.finalizedAt != null;
      const humanEdited = isHumanEdit(ti.updatedBy);

      // Precedence: FINALIZED (locked) > NEW override this session > PRIOR manual
      // override > HUMAN task-UI edit (staff curation — preserved) > computed.
      let finalStatus: TaskStatus;
      let finalOutcome: TaskOutcome;
      let finalCompletedOn: string | null;
      let finalNote: string;
      if (finalized) {
        finalStatus = ti.status;
        finalOutcome = ti.outcome;
        finalCompletedOn = ti.completedOn;
        finalNote = ti.staffNote ?? decision.note;
      } else if (override) {
        const t = dispositionToTask(override.disposition, subDate, today);
        finalStatus = t.status;
        finalOutcome = t.outcome;
        finalCompletedOn = t.completedOn;
        finalNote = override.comment.trim() || decision.note;
      } else if (priorOverride) {
        finalStatus = ti.status;
        finalOutcome = ti.outcome;
        finalCompletedOn = ti.completedOn;
        finalNote = ti.staffNote ?? decision.note;
      } else if (humanEdited) {
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
        period,
        category: decision.category,
        overridden: !!override,
        priorOverride,
        finalized,
        finalizedAt: ti.finalizedAt ? ti.finalizedAt.toISOString() : null,
        finalizedBy: ti.finalizedBy ?? null,
        sspSubmitted: cell?.ssp.submitted ?? false,
        chartSubmitted: cell?.chart.submitted ?? false,
        bothSubmitted: cell?.bothSubmitted ?? false,
        dataComplete: cell?.dataComplete ?? false,
        sspRows: cell?.ssp.nRows ?? 0,
        sspComplete: cell?.ssp.nComplete ?? 0,
        chartRows: cell?.chart.nRows ?? 0,
        chartComplete: cell?.chart.nComplete ?? 0,
        incompleteRecords:
          decision.category === 'incomplete'
            ? collectMissing(
                [
                  { form: 'Safe Sleep Practices', rollup: cell?.ssp },
                  { form: 'Chart audit', rollup: cell?.chart },
                ],
                fieldLabels,
              )
            : [],
        onTime: effCell?.onTime ?? null,
        daysFromDeadline: effCell?.daysFromDeadline ?? null,
        submissionDate: subDate,
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
              program: 'NEST',
              period,
              bothSubmitted: cell?.bothSubmitted ?? false,
              dataComplete: cell?.dataComplete ?? false,
              ssp: { rows: cell?.ssp.nRows ?? 0, complete: cell?.ssp.nComplete ?? 0 },
              chart: { rows: cell?.chart.nRows ?? 0, complete: cell?.chart.nComplete ?? 0 },
              onTime: effCell?.onTime ?? null,
              daysFromDeadline: effCell?.daysFromDeadline ?? null,
              submissionDate: subDate,
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
    unchanged: rows.filter((r) => !r.willChange).length,
  };

  logger.info(
    { dryRun: opts.dryRun, programYear, recordsFetched: records.length, ...counts },
    'NEST REDCap sync complete',
  );

  return {
    dryRun: opts.dryRun,
    fetchedAt,
    programYear,
    periodsInScope,
    recordsFetched: records.length,
    rows,
    warnings,
    counts,
  };
}
