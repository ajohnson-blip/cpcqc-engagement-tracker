/**
 * SOAR REDCap sync. Pulls the two SOAR forms (ntsv_cesarean_section +
 * no_ntsv_csections) from REDCap, runs the SOAR engagement logic (ported in
 * ./soar-engagement.ts), and maps the result onto each SOAR-active hospital's
 * MONTHLY data_submission task instances.
 *
 * Policy (chosen by CPCQC — strict, matches SPARK/NEST):
 *   - A month COUNTS only when it was submitted, complete, and on time
 *     (status=complete, outcome=on_time).
 *   - A valid No-NTSV (zero-case) attestation counts as a complete submission,
 *     so low-volume hospitals aren't penalized for having no eligible cases.
 *   - Complete but late → complete / late (recorded, doesn't count).
 *   - Submitted but any NTSV row fails completeness (or the attestation is
 *     incomplete) → needs_revision (recorded, doesn't count until fixed).
 *   - Nothing by the deadline → complete / not_submitted (documented miss).
 *   - Nothing yet, deadline not passed → left untouched (pending).
 *
 * Timeliness uses the task's due_on — CPCQC's official 2026 deadline sheet, the
 * authoritative source. The sheet lists "Submit June 2026 data" onward, so the
 * early-2026 months (which carry a pre-CSV same-month placeholder due date) fall
 * back to the computed 2nd-Friday-of-the-following-month rule.
 *
 * Dry-run previews; re-running is idempotent (recomputed from REDCap each time).
 */
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { exportRecords } from './redcap.client.js';
import { buildSoarGrid, monthDeadline, NTSV_FORM, NO_NTSV_FORM, type SoarCell } from './soar-engagement.js';
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
 * Reporting periods under the pre-May 2026 grace: the operational definition of
 * "timely & complete" wasn't communicated to hospitals until May, so Jan–April
 * submissions are credited as complete + on time. (2026-specific.)
 */
const GRACE_PERIODS = new Set(['2026-01', '2026-02', '2026-03', '2026-04']);

/**
 * REDCap SOAR Data Access Group → our canonical hospital name. Only the 16
 * hospitals in the SOAR *active* (monthly) cohort are listed — those are the
 * sync targets. The other DAGs in the SOAR project (sustainability-track or not
 * enrolled) submit NTSV data too but have no monthly data-submission tasks, so
 * they're reported as skipped warnings. Names verified against production.
 */
export const SOAR_DAG_TO_HOSPITAL_NAME: Record<string, string> = {
  advent_health_avis: 'AdventHealth Avista',
  advent_health_cast: 'AdventHealth Castle Rock',
  advent_health_park: 'AdventHealth Parker',
  aspen_valley_hospi: 'Aspen Valley Hospital',
  longmont_united: 'CommonSpirit - Longmont United Hospital',
  st_anthony_north_h: 'CommonSpirit - St. Anthony North Hospital',
  st_elizabeth_hospi: 'CommonSpirit - St. Elizabeth Hospital',
  gunnison_valley_he: 'Gunnison Valley Health',
  mountain_ridge: 'HCA HealthONE Mountain Ridge',
  heart_of_the_rocki: 'Heart of The Rockies Regional Medical Center',
  good_samaritan_med: 'Intermountain Health Good Samaritan Hospital',
  saint_joseph_hospi: 'Intermountain Health Saint Joseph Hospital',
  prowers_medical_ce: 'Prowers Medical Center',
  southwest_health: 'Southwest Health System, Inc.',
  sterling_regional: 'Sterling Regional MedCenter',
  wray_community_dis: 'Wray Community District Hospital',
};

/**
 * SOAR DAGs that submit data but are NOT in the active monthly cohort and are
 * KNOWN + accounted for — sustainability-track or not enrolled — per CPCQC's
 * "SOAR Sustainability and Not Participation" list. These are expected skips, so
 * they're summarized as an info note rather than flagged as per-DAG warnings.
 * A seen DAG that's neither active nor here IS unexpected → a real warning.
 */
export const SOAR_KNOWN_NON_ACTIVE: Record<string, 'sustainability' | 'not_enrolled'> = {
  north_colorado_med: 'sustainability',
  medical_center_of: 'sustainability',
  vail_health_hospit: 'sustainability',
  valley_view_hospit: 'sustainability',
  uchealth_greeley: 'sustainability',
  denver_health: 'sustainability',
  medical_center_ofb: 'sustainability',
  poudre_valley_hosp: 'sustainability',
  swedish_medical_ce: 'sustainability',
  uchealth_yampa_val: 'sustainability',
  banner_fort_collin: 'sustainability',
  uc_health_highland: 'sustainability',
  montrose_memorial: 'sustainability',
  san_luis_valley_he: 'sustainability',
  uchealth_memorial: 'not_enrolled',
  saint_marys_hospit: 'not_enrolled',
  uchealth_longs_pea: 'not_enrolled',
  lutheran_medical_c: 'not_enrolled',
  platte_valley_medi: 'not_enrolled',
  delta_hospital: 'not_enrolled',
  community_hospital: 'not_enrolled',
};

export type SoarSyncCategory =
  | 'counting'
  | 'complete_late'
  | 'complete_nodate'
  | 'incomplete'
  | 'not_submitted'
  | 'pending';

type TaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
type TaskOutcome = 'on_time' | 'late' | 'attended' | 'missed' | 'not_submitted' | null;

export interface SoarSyncRow {
  taskId: string;
  dagCode: string;
  hospitalId: string | null;
  hospitalName: string;
  period: string; // "2026-03"
  category: SoarSyncCategory;
  /** True when a PM override (not the computed value) is being applied. */
  overridden: boolean;
  /** A prior manual override already stored on this task (preserved by the sync). */
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  /** Finalized (locked): the sync leaves it alone; the preview shows it read-only. */
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  ntsvSubmitted: boolean;
  noNtsvSubmitted: boolean;
  /** The only submission is a valid zero-case attestation. */
  attestationOnly: boolean;
  dataComplete: boolean;
  ntsvRows: number;
  ntsvComplete: number;
  noNtsvRows: number;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  currentStatus: TaskStatus;
  currentOutcome: TaskOutcome;
  newStatus: TaskStatus;
  newOutcome: TaskOutcome;
  willChange: boolean;
  note: string;
}

export interface SoarSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  periodsInScope: string[];
  recordsFetched: number;
  rows: SoarSyncRow[];
  /** Genuinely actionable items (unexpected DAGs, future-date typos, etc.). */
  warnings: string[];
  /** Expected/informational notes (e.g. known non-active DAGs skipped). */
  notes: string[];
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
  category: SoarSyncCategory;
  status: TaskStatus;
  outcome: TaskOutcome;
  completedOn: string | null;
  leaveUntouched: boolean;
  note: string;
}

function decide(cell: SoarCell | undefined, deadline: string, today: string, graced: boolean): Decision {
  const deadlinePassed = today > deadline;
  const anySubmitted = !!cell && cell.submitted;

  // Pre-May 2026 grace: CPCQC didn't communicate the "timely & complete"
  // operational definition to hospital teams until May, so any Jan–April
  // submission is credited as complete + on time regardless of field-level
  // completeness or lateness. Non-submissions are unaffected (still not_submitted
  // / pending below).
  if (graced && anySubmitted) {
    return {
      category: 'counting',
      status: 'complete',
      outcome: 'on_time',
      completedOn: cell!.earliestSubmissionDate,
      leaveUntouched: false,
      note: `Submitted; pre-May 2026 grace (the "timely & complete" definition wasn't communicated to hospitals until May) — counts toward requirement.`,
    };
  }

  if (!anySubmitted) {
    if (deadlinePassed) {
      return {
        category: 'not_submitted',
        status: 'complete',
        outcome: 'not_submitted',
        completedOn: null,
        leaveUntouched: false,
        note: `No NTSV cases and no zero-case attestation; deadline ${deadline} has passed.`,
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
  const what = c.attestationOnly ? 'Zero-case attestation' : `${c.ntsv.nRows} NTSV case(s)`;

  if (c.dataComplete) {
    if (c.onTime === true) {
      return {
        category: 'counting',
        status: 'complete',
        outcome: 'on_time',
        completedOn: date,
        leaveUntouched: false,
        note: `${what} complete + on time (submitted ${date}). Counts toward requirement.`,
      };
    }
    if (c.onTime === false) {
      return {
        category: 'complete_late',
        status: 'complete',
        outcome: 'late',
        completedOn: date,
        leaveUntouched: false,
        note: `${what} complete but LATE (${date}, ${c.daysFromDeadline} days past ${deadline}). Does not count.`,
      };
    }
    return {
      category: 'complete_nodate',
      status: 'complete',
      outcome: null,
      completedOn: null,
      leaveUntouched: false,
      note: `${what} complete; no submission date (timeliness N/A). Counts toward requirement.`,
    };
  }

  // Submitted but not complete → needs_revision (does not count).
  const detail = c.attestationOnly
    ? 'zero-case attestation is missing a required field'
    : `NTSV cases ${c.ntsv.nComplete}/${c.ntsv.nRows} complete — not all rows pass`;
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
      updatedBy: 'redcap-soar-sync',
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

export interface RunSoarSyncOptions {
  dryRun: boolean;
  programYear?: number;
  actorUserId?: string | null;
  /** PM overrides keyed by task instance id (apply only). */
  overrides?: Map<string, SyncOverride>;
}

export async function runSoarRedcapSync(opts: RunSoarSyncOptions): Promise<SoarSyncResult> {
  if (!env.REDCAP_SOAR_TOKEN) {
    throw new HttpError(
      400,
      'REDCAP_SOAR_TOKEN is not configured on the server. Add it as a Render environment variable.',
    );
  }

  const programYear = opts.programYear ?? 2026;
  const today = new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();

  const records = await exportRecords({
    token: env.REDCAP_SOAR_TOKEN,
    forms: [NTSV_FORM, NO_NTSV_FORM],
  });
  const grid = buildSoarGrid(records, { year: programYear, todayIso: today });

  const hospitals = await db.select().from(schema.hospitals);
  const hospitalsByName = new Map(hospitals.map((h) => [h.name.toLowerCase(), h]));
  const soar = await db.query.initiatives.findFirst({ where: eq(schema.initiatives.code, 'SOAR') });
  if (!soar) throw new HttpError(500, 'SOAR initiative not found in the database.');

  // Per-period official deadline from the task due dates (CPCQC's sheet). Used by
  // the scope filter; the per-task loop reads each task's own due_on directly.
  const dueRows = await db
    .select({ period: schema.taskInstances.period, dueOn: schema.taskInstances.dueOn })
    .from(schema.taskInstances)
    .innerJoin(schema.taskTemplates, eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId))
    .innerJoin(schema.programYears, eq(schema.programYears.id, schema.taskInstances.programYearId))
    .where(
      and(
        eq(schema.taskTemplates.initiativeId, soar.id),
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
    .where(and(eq(schema.cohorts.initiativeId, soar.id), eq(schema.cohorts.track, 'active')));
  const coveringCohorts = cohorts.filter((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return programYear >= start && programYear <= end;
  });

  const rows: SoarSyncRow[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // DAGs with data that we DON'T sync. Known sustainability/not-enrolled DAGs are
  // expected → summarized as a note; a DAG that's neither active nor known is a
  // real "needs attention" item (possible new hospital / mis-labeled DAG).
  const seenDags = new Set(
    records.map((r) => String(r['redcap_data_access_group'] ?? '').trim()).filter(Boolean),
  );
  let sustainSkipped = 0;
  let notEnrolledSkipped = 0;
  for (const dag of seenDags) {
    if (dag === 'test' || dag in SOAR_DAG_TO_HOSPITAL_NAME) continue;
    const known = SOAR_KNOWN_NON_ACTIVE[dag];
    if (known === 'sustainability') sustainSkipped += 1;
    else if (known === 'not_enrolled') notEnrolledSkipped += 1;
    else
      warnings.push(
        `REDCap DAG "${dag}" has SOAR data but is neither in the active cohort nor the known sustainability/not-enrolled list — investigate (possible new or mis-labeled hospital).`,
      );
  }
  const totalSkipped = sustainSkipped + notEnrolledSkipped;
  if (totalSkipped > 0) {
    notes.push(
      `Skipped ${totalSkipped} known non-active DAG${totalSkipped === 1 ? '' : 's'} with SOAR data — expected (${sustainSkipped} sustainability, ${notEnrolledSkipped} not enrolled).`,
    );
  }

  for (const [dag, hospitalName] of Object.entries(SOAR_DAG_TO_HOSPITAL_NAME)) {
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
        `${hospitalName} is in the SOAR REDCap project but has no SOAR-active enrollment for ${programYear} — skipped.`,
      );
      continue;
    }

    for (const period of periodsInScope) {
      const cell = grid.get(`${dag}::${period}`);

      if (cell && cell.futureDated > 0) {
        warnings.push(
          `${hospitalName} ${period}: ${cell.futureDated} NTSV row(s) have a future delivery_date — possible data-entry typo.`,
        );
      }

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

      // Authoritative deadline = this task's due_on (CPCQC sheet); early-2026
      // months fall back to the computed 2nd-Friday rule. Recompute timeliness
      // against it, overriding the grid's own computation.
      const deadline = deadlineFor(period, ti.dueOn);
      const subDate = cell?.earliestSubmissionDate ?? null;
      const tl = recomputeTimeliness(subDate, deadline);
      const effCell = cell
        ? { ...cell, deadline, onTime: tl.onTime, daysFromDeadline: tl.daysFromDeadline }
        : undefined;

      const decision = decide(effCell, deadline, today, GRACE_PERIODS.has(period));
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
        ntsvSubmitted: cell?.ntsv.submitted ?? false,
        noNtsvSubmitted: cell?.noNtsv.submitted ?? false,
        attestationOnly: cell?.attestationOnly ?? false,
        dataComplete: cell?.dataComplete ?? false,
        ntsvRows: cell?.ntsv.nRows ?? 0,
        ntsvComplete: cell?.ntsv.nComplete ?? 0,
        noNtsvRows: cell?.noNtsv.nRows ?? 0,
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
              program: 'SOAR',
              period,
              ntsvSubmitted: cell?.ntsv.submitted ?? false,
              noNtsvSubmitted: cell?.noNtsv.submitted ?? false,
              attestationOnly: cell?.attestationOnly ?? false,
              dataComplete: cell?.dataComplete ?? false,
              ntsv: { rows: cell?.ntsv.nRows ?? 0, complete: cell?.ntsv.nComplete ?? 0 },
              noNtsvRows: cell?.noNtsv.nRows ?? 0,
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
    'SOAR REDCap sync complete',
  );

  return {
    dryRun: opts.dryRun,
    fetchedAt,
    programYear,
    periodsInScope,
    recordsFetched: records.length,
    rows,
    warnings,
    notes,
    counts,
  };
}
