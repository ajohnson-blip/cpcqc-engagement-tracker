/**
 * Turning the Tide (TtT) REDCap sync — the most involved of the four programs.
 *
 * Pulls BOTH TtT projects and reconciles them:
 *   - monthly HOSPITAL form → aggregate screening counts (incl. positive SUD
 *     screens) + report-level completeness + submission time
 *   - PATIENT-level form → one row per patient (PHI; we only ever COUNT rows)
 * and joins them on CHA_ID via the crosswalk (DAGs are NOT a safe cross-project
 * key — see ttt-crosswalk.ts).
 *
 * Completeness is two layers: required fields non-blank, AND the linkage rule
 * (each positive screen should have a patient form). Only the linkage FLOOR
 * (≥1 form when positives > 0) is pass/fail; the IDEAL (one-per-positive) is
 * reported but never fails a hospital.
 *
 * Deadline = the task's due_on (CPCQC's sheet — which makes Dec 2026 data due
 * 2027-01-22, a deliberate 4th-Friday exception), falling back to the computed
 * 3rd-Friday-of-the-following-month rule for periods the sheet doesn't list.
 *
 * Active cohort = the tracker's TtT enrollment (NOT the crosswalk's Active_2026
 * flag, which is inverted on Littleton/Good Samaritan).
 */
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { exportRecords, exportMetadata, exportLog } from './redcap.client.js';
import {
  MONTHLY_HOSPITAL_FORM,
  PATIENT_FORM,
  MONTH_REPORTING_FIELD,
  POSITIVE_SCREEN_FIELD,
  F_DAG,
  F_RECORD_ID,
  REQUIRED_FIELDS_EXCLUDE,
  monthCodeToPeriod,
  monthDeadline,
  patientPeriod,
  patientEligible,
  checkCompleteness,
  linkageFloorMet,
  linkageIdealMet,
  classifyTtt,
  isValidDate,
  type EligibilityMode,
  type TttSyncCategory,
} from './ttt-engagement.js';
import {
  TTT_HOSPITALS,
  TTT_NON_HOSPITAL_DAGS,
  DAG_TO_CHA_ID,
  normalizeHospitalName,
} from './ttt-crosswalk.js';
import {
  dispositionToTask,
  isHumanEdit,
  isoDate,
  periodEndIso,
  resolveDeadline,
  toIsoDateOrNull,
  type SyncOverride,
  type SyncDisposition,
} from './sync-overrides.js';

type TaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
type TaskOutcome = 'on_time' | 'late' | 'attended' | 'missed' | 'not_submitted' | null;

function readPriorOverride(
  ti: typeof schema.taskInstances.$inferSelect,
): { disposition: SyncDisposition; comment: string } | null {
  const ov = (ti.payload as { override?: { disposition?: SyncDisposition; comment?: string } } | null)
    ?.override;
  if (!ov?.disposition) return null;
  return { disposition: ov.disposition, comment: ov.comment ?? '' };
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** What writing a computed category does to the task. */
function categoryToTask(
  category: TttSyncCategory,
  submissionDate: string | null,
): { status: TaskStatus; outcome: TaskOutcome; completedOn: string | null; leaveUntouched: boolean } {
  switch (category) {
    case 'counting':
    case 'below_ideal': // floor met — still counts; the shortfall is a note only
      return { status: 'complete', outcome: 'on_time', completedOn: submissionDate, leaveUntouched: false };
    case 'complete_late':
      return { status: 'complete', outcome: 'late', completedOn: submissionDate, leaveUntouched: false };
    case 'complete_nodate':
      return { status: 'complete', outcome: null, completedOn: null, leaveUntouched: false };
    case 'incomplete':
      return { status: 'needs_revision', outcome: null, completedOn: null, leaveUntouched: false };
    case 'not_submitted':
      return { status: 'complete', outcome: 'not_submitted', completedOn: null, leaveUntouched: false };
    case 'pending':
      return { status: 'not_started', outcome: null, completedOn: null, leaveUntouched: true };
  }
}

export interface TttSyncRow {
  taskId: string;
  chaId: number;
  hospitalId: string | null;
  hospitalName: string;
  period: string;
  category: TttSyncCategory;
  overridden: boolean;
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  submitted: boolean;
  reportComplete: boolean;
  missingFields: string[];
  positiveScreens: number;
  patientForms: number;
  shortfall: number;
  linkageFloor: boolean;
  linkageIdeal: boolean;
  onTime: boolean | null;
  submissionDate: string | null;
  deadline: string;
  currentStatus: TaskStatus;
  currentOutcome: TaskOutcome;
  newStatus: TaskStatus;
  newOutcome: TaskOutcome;
  willChange: boolean;
  note: string;
}

export interface TttSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  eligibilityMode: EligibilityMode;
  periodsInScope: string[];
  hospitalRecords: number;
  patientRecords: number;
  requiredFieldCount: number;
  rows: TttSyncRow[];
  warnings: string[];
  notes: string[];
  counts: {
    willChange: number;
    counting: number;
    belowIdeal: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    unchanged: number;
    linkageGaps: number;
  };
}

interface HospitalCell {
  positives: number;
  complete: boolean;
  missing: string[];
  submissionDate: string | null;
  nRecords: number;
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
      updatedBy: 'redcap-ttt-sync',
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
    diff: { from: { status: ti.status, outcome: ti.outcome }, to: { status: patch.status, outcome: patch.outcome } },
    note: patch.note,
  });
}

export interface RunTttSyncOptions {
  dryRun: boolean;
  programYear?: number;
  actorUserId?: string | null;
  overrides?: Map<string, SyncOverride>;
  /** CPCQC's choice is 'derived' (catches forms with a substance but a blank
   *  eligibility checkbox). Configurable for a strict-explicit cut. */
  eligibilityMode?: EligibilityMode;
}

export async function runTttRedcapSync(opts: RunTttSyncOptions): Promise<TttSyncResult> {
  if (!env.REDCAP_TTT_HOSPITAL_TOKEN || !env.REDCAP_TTT_PATIENT_TOKEN) {
    throw new HttpError(
      400,
      'REDCAP_TTT_HOSPITAL_TOKEN and REDCAP_TTT_PATIENT_TOKEN must both be configured (TtT spans two projects).',
    );
  }

  const programYear = opts.programYear ?? 2026;
  const eligibilityMode = opts.eligibilityMode ?? 'derived';
  const today = new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString();
  const warnings: string[] = [];
  const notes: string[] = [];

  // ---- 1. Pull both projects + the dictionary + the audit log --------------
  const hospitalRows = await exportRecords({
    token: env.REDCAP_TTT_HOSPITAL_TOKEN,
    form: MONTHLY_HOSPITAL_FORM,
  });
  const patientRows = await exportRecords({
    token: env.REDCAP_TTT_PATIENT_TOKEN,
    form: PATIENT_FORM,
  });

  // Required fields come from the live data dictionary: required_field='y' on the
  // monthly instrument, minus @HIDDEN/retired and the documented excludes.
  const metadata = await exportMetadata({ token: env.REDCAP_TTT_HOSPITAL_TOKEN });
  const requiredFields = metadata
    .filter((m) => String(m['required_field'] ?? '').trim().toLowerCase() === 'y')
    .filter((m) => !m['form_name'] || m['form_name'] === MONTHLY_HOSPITAL_FORM)
    .filter((m) => !/@HIDDEN/i.test(String(m['field_annotation'] ?? '')))
    .map((m) => String(m['field_name'] ?? '').trim())
    .filter((f) => f && !REQUIRED_FIELDS_EXCLUDE.has(f));
  notes.push(`Required fields from the REDCap dictionary: ${requiredFields.length} (after @HIDDEN + excludes).`);

  // Submission time = earliest "Create Record" log entry for the record.
  const submittedAtByRecord = new Map<string, string>();
  try {
    const log = await exportLog({
      token: env.REDCAP_TTT_HOSPITAL_TOKEN,
      beginTime: `${programYear}-01-01 00:00`,
    });
    for (const entry of log) {
      if (!/create/i.test(String(entry['action'] ?? ''))) continue;
      const rec = String(entry['record'] ?? '').trim();
      const ts = String(entry['timestamp'] ?? '').trim().slice(0, 10);
      if (!rec || !isValidDate(ts)) continue;
      const prior = submittedAtByRecord.get(rec);
      if (!prior || ts < prior) submittedAtByRecord.set(rec, ts);
    }
  } catch (err) {
    warnings.push(
      `REDCap log API unavailable (${err instanceof Error ? err.message : String(err)}) — submission times unknown, so timeliness reads N/A this run.`,
    );
  }

  // ---- 2. Unrecognized DAGs: log, never silently drop ---------------------
  const seenDags = new Set<string>();
  for (const r of [...hospitalRows, ...patientRows]) {
    const d = String(r[F_DAG] ?? '').trim();
    if (d) seenDags.add(d);
  }
  let expectedSkips = 0;
  for (const dag of seenDags) {
    if (DAG_TO_CHA_ID.has(dag)) continue;
    if (TTT_NON_HOSPITAL_DAGS.has(dag)) {
      expectedSkips += 1;
      continue;
    }
    warnings.push(
      `REDCap DAG "${dag}" has TtT data but is not in the crosswalk — investigate (possible new hospital or DAG rename). Its rows are being skipped.`,
    );
  }
  if (expectedSkips > 0) {
    notes.push(`${expectedSkips} non-TtT DAG(s) in the shared projects skipped — expected.`);
  }

  // ---- 3. Hospital grid: (CHA_ID, period) -> aggregate --------------------
  const hospitalCells = new Map<string, HospitalCell>();
  for (const r of hospitalRows) {
    const chaId = DAG_TO_CHA_ID.get(String(r[F_DAG] ?? '').trim());
    if (chaId === undefined) continue;
    const period = monthCodeToPeriod(r[MONTH_REPORTING_FIELD]);
    if (!period || !period.startsWith(String(programYear))) continue;
    const key = `${chaId}::${period}`;
    const cur =
      hospitalCells.get(key) ?? { positives: 0, complete: false, missing: [], submissionDate: null, nRecords: 0 };
    const res = checkCompleteness(r, requiredFields);
    cur.positives += toNum(r[POSITIVE_SCREEN_FIELD]);
    // A hospital-month is complete if ANY of its records is complete (Luis's rule).
    cur.complete = cur.complete || res.complete;
    for (const f of res.missing) if (!cur.missing.includes(f)) cur.missing.push(f);
    cur.nRecords += 1;
    const ts = submittedAtByRecord.get(String(r[F_RECORD_ID] ?? '').trim());
    if (ts && (!cur.submissionDate || ts < cur.submissionDate)) cur.submissionDate = ts;
    hospitalCells.set(key, cur);
  }

  // ---- 4. Eligible patient forms: (CHA_ID, period) -> count ---------------
  // NB: PHI project — we only ever count rows, never read identifiers.
  const patientCounts = new Map<string, number>();
  let eligibleTotal = 0;
  for (const r of patientRows) {
    const chaId = DAG_TO_CHA_ID.get(String(r[F_DAG] ?? '').trim());
    if (chaId === undefined) continue;
    const period = patientPeriod(r);
    if (!period || !period.startsWith(String(programYear))) continue;
    if (!patientEligible(r, eligibilityMode)) continue;
    const key = `${chaId}::${period}`;
    patientCounts.set(key, (patientCounts.get(key) ?? 0) + 1);
    eligibleTotal += 1;
  }
  notes.push(`Eligible ${programYear} patient forms (mode=${eligibilityMode}): ${eligibleTotal}.`);

  // ---- 5. Tracker: initiative, enrollments, due dates ---------------------
  const ttt = await db.query.initiatives.findFirst({ where: eq(schema.initiatives.code, 'TTT') });
  if (!ttt) throw new HttpError(500, 'TTT initiative not found in the database.');

  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(and(eq(schema.cohorts.initiativeId, ttt.id), eq(schema.cohorts.track, 'active')));
  const coveringCohorts = cohorts.filter((c) => {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    return programYear >= start && programYear <= end;
  });

  const hospitals = await db.select().from(schema.hospitals);
  const hospitalsByName = new Map(hospitals.map((h) => [normalizeHospitalName(h.name), h]));

  const dueRows = await db
    .select({ period: schema.taskInstances.period, dueOn: schema.taskInstances.dueOn })
    .from(schema.taskInstances)
    .innerJoin(schema.taskTemplates, eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId))
    .innerJoin(schema.programYears, eq(schema.programYears.id, schema.taskInstances.programYearId))
    .where(
      and(
        eq(schema.taskTemplates.initiativeId, ttt.id),
        eq(schema.taskTemplates.taskType, 'data_submission'),
        eq(schema.programYears.year, programYear),
      ),
    );
  const periodDueOn = new Map<string, string>();
  for (const r of dueRows) if (r.dueOn) periodDueOn.set(r.period, isoDate(r.dueOn));

  /** Sheet's due_on where it's a real deadline (Dec 2026 → 2027-01-22), else the
   *  computed 3rd-Friday-of-the-following-month rule. */
  const deadlineFor = (period: string, dueOn: string | Date | null): string =>
    resolveDeadline(dueOn, periodEndIso(period), monthDeadline(programYear, parseInt(period.slice(5), 10)));

  const periodsInScope = Array.from({ length: 12 }, (_, i) => `${programYear}-${String(i + 1).padStart(2, '0')}`)
    .filter((period) => {
      const deadline = deadlineFor(period, periodDueOn.get(period) ?? null);
      const hasData =
        [...hospitalCells.keys()].some((k) => k.endsWith(`::${period}`)) ||
        [...patientCounts.keys()].some((k) => k.endsWith(`::${period}`));
      return today > deadline || hasData;
    });

  // ---- 6. Walk the tracker's TtT-enrolled hospitals -----------------------
  const rows: TttSyncRow[] = [];

  for (const xw of TTT_HOSPITALS) {
    const hospital = hospitalsByName.get(normalizeHospitalName(xw.trackerName));
    if (!hospital) continue; // not a tracker hospital at all

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
    // No TtT enrollment → not in the 2026 cohort (expected for the 6 the
    // crosswalk lists but CPCQC didn't enroll). Silent unless it has data.
    if (!enrollment) {
      const hasData = [...hospitalCells.keys()].some((k) => k.startsWith(`${xw.chaId}::`));
      if (hasData) {
        notes.push(`${xw.trackerName} (CHA ${xw.chaId}) has TtT data but no ${programYear} TtT enrollment — skipped.`);
      }
      continue;
    }

    for (const period of periodsInScope) {
      const key = `${xw.chaId}::${period}`;
      const cell = hospitalCells.get(key);
      const patientForms = patientCounts.get(key) ?? 0;

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
          warnings.push(`${xw.trackerName} has TtT data for ${period} but no matching data-submission task — skipped.`);
        }
        continue;
      }

      const deadline = deadlineFor(period, ti.dueOn);
      const submitted = !!cell;
      const positives = cell?.positives ?? 0;
      const submissionDate = cell?.submissionDate ?? null;
      const onTime = submissionDate ? submissionDate <= deadline : null;
      const floor = linkageFloorMet(positives, patientForms);
      const ideal = linkageIdealMet(positives, patientForms);

      const decision = classifyTtt({
        submitted,
        deadlinePassed: today > deadline,
        onTime,
        complete: cell?.complete ?? false,
        missing: cell?.missing ?? [],
        linkageFloor: floor,
        linkageIdeal: ideal,
        positiveScreens: positives,
        patientForms,
      });
      const computed = categoryToTask(decision.category, submissionDate);

      const override = opts.overrides?.get(ti.id);
      const priorOverride = readPriorOverride(ti);
      const finalized = ti.finalizedAt != null;
      const humanEdited = isHumanEdit(ti.updatedBy);

      // Precedence: FINALIZED > NEW override > PRIOR override > HUMAN edit > computed.
      let finalStatus: TaskStatus;
      let finalOutcome: TaskOutcome;
      let finalCompletedOn: string | null;
      let finalNote: string;
      if (finalized || priorOverride || humanEdited) {
        finalStatus = ti.status;
        finalOutcome = ti.outcome;
        finalCompletedOn = ti.completedOn;
        finalNote = ti.staffNote ?? decision.reasons.join(' ');
      } else if (override) {
        const t = dispositionToTask(override.disposition, submissionDate, today);
        finalStatus = t.status;
        finalOutcome = t.outcome;
        finalCompletedOn = t.completedOn;
        finalNote = override.comment.trim() || decision.reasons.join(' ');
      } else if (computed.leaveUntouched) {
        finalStatus = ti.status;
        finalOutcome = ti.outcome;
        finalCompletedOn = ti.completedOn;
        finalNote = decision.reasons.join(' ');
      } else {
        finalStatus = computed.status;
        finalOutcome = computed.outcome;
        finalCompletedOn = computed.completedOn;
        finalNote = decision.reasons.join(' ');
      }

      const willChange =
        finalStatus !== ti.status ||
        finalOutcome !== ti.outcome ||
        (!!override && finalNote !== (ti.staffNote ?? ''));

      rows.push({
        taskId: ti.id,
        chaId: xw.chaId,
        hospitalId: hospital.id,
        hospitalName: xw.trackerName,
        period,
        category: decision.category,
        overridden: !!override,
        priorOverride,
        finalized,
        finalizedAt: ti.finalizedAt ? ti.finalizedAt.toISOString() : null,
        finalizedBy: ti.finalizedBy ?? null,
        submitted,
        reportComplete: cell?.complete ?? false,
        missingFields: cell?.missing ?? [],
        positiveScreens: positives,
        patientForms,
        shortfall: decision.shortfall,
        linkageFloor: floor,
        linkageIdeal: ideal,
        onTime,
        submissionDate,
        deadline,
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
              program: 'TTT',
              period,
              chaId: xw.chaId,
              submitted,
              reportComplete: cell?.complete ?? false,
              missingFields: cell?.missing ?? [],
              positiveScreens: positives,
              patientForms,
              shortfall: decision.shortfall,
              linkageFloor: floor,
              linkageIdeal: ideal,
              eligibilityMode,
              onTime,
              submissionDate,
              deadline,
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
    belowIdeal: rows.filter((r) => r.category === 'below_ideal').length,
    completeLate: rows.filter((r) => r.category === 'complete_late').length,
    incomplete: rows.filter((r) => r.category === 'incomplete').length,
    notSubmitted: rows.filter((r) => r.category === 'not_submitted').length,
    pending: rows.filter((r) => r.category === 'pending').length,
    unchanged: rows.filter((r) => !r.willChange).length,
    linkageGaps: rows.filter((r) => r.submitted && !r.linkageFloor).length,
  };

  logger.info(
    {
      dryRun: opts.dryRun,
      programYear,
      hospitalRecords: hospitalRows.length,
      patientRecords: patientRows.length,
      requiredFields: requiredFields.length,
      ...counts,
    },
    'TtT REDCap sync complete',
  );

  return {
    dryRun: opts.dryRun,
    fetchedAt,
    programYear,
    eligibilityMode,
    periodsInScope,
    hospitalRecords: hospitalRows.length,
    patientRecords: patientRows.length,
    requiredFieldCount: requiredFields.length,
    rows,
    warnings,
    notes,
    counts,
  };
}
