/**
 * Turning the Tide (TtT) engagement logic — TypeScript port of Luis Montes'
 * (CHA) TtT module. Pure, dependency-free, unit-tested.
 *
 * TtT is the most involved program:
 *   - TWO REDCap projects, cross-linked on CHA_ID (see ttt-crosswalk.ts): a
 *     MONTHLY HOSPITAL form (aggregate screening counts, incl. positive SUD
 *     screens) and a PATIENT-LEVEL form (one row per screened patient — PHI).
 *   - Monthly, previous-month reporting; deadline = 3rd Friday of the FOLLOWING
 *     month (same convention as the CSV's TtT dates).
 *   - Completeness has TWO layers: (1) report-level required fields non-blank,
 *     and (2) cross-project LINKAGE — each positive SUD screen should have a
 *     patient form. Floor (pass/fail) = ≥1 patient form when positives > 0; the
 *     ideal (one-per-positive) is reported but NON-BLOCKING.
 *   - Patient eligibility = "derived" (CPCQC's choice): a qualifying substance
 *     is checked AND the record isn't explicitly ineligible. Catches real forms
 *     whose eligibility checkbox was left blank.
 */

export type RedcapRow = Record<string, string | null | undefined>;

// Field / form names --------------------------------------------------------
export const F_DAG = 'redcap_data_access_group';
export const F_RECORD_ID = 'record_id';
export const MONTHLY_HOSPITAL_FORM = 'co_aim_sud_learning_collaborative_monthly_hospital';
export const PATIENT_FORM = 'co_aim_sud_quantitative_patientlevel_data';
export const POSITIVE_SCREEN_FIELD = 'tot_sud_scrnd_pos';
export const MONTH_REPORTING_FIELD = 'month_reporting';
export const PATIENT_DELIVERY_FIELD = 'delivery_date_1';
export const ELIGIBILITY_FIELD = 'sample_check_patient';

const ELIGIBLE_VALUE = 1;
const INELIGIBLE_VALUE = 2;
/** Qualifying SUD substances — excludes 7 (cannabis-only) and 10 (nicotine-only). */
const QUALIFYING_SUBSTANCE_CODES = ['1', '2', '4', '5', '6', '8', '9'];

/** Required fields that are `required=y` in REDCap but must NOT be enforced:
 *  tot_anx_scrnd may legitimately be blank ("leave blank if anxiety isn't
 *  assessed separately"). @HIDDEN/retired fields are dropped by the metadata
 *  fetch itself (annotation contains @HIDDEN). */
export const REQUIRED_FIELDS_EXCLUDE = new Set(['tot_anx_scrnd']);

export type EligibilityMode = 'explicit' | 'derived' | 'either';

// Helpers -------------------------------------------------------------------
export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

export function isValidDate(value: unknown): boolean {
  if (!isFieldFilled(value)) return false;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function toNum(value: unknown): number {
  const n = parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : NaN;
}

// =====================================================================
// Deadlines — 3rd Friday of the month AFTER the reporting month
// =====================================================================

export function thirdFriday(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const dow = first.getUTCDay(); // 0=Sun … 5=Fri … 6=Sat
  const daysToFirstFriday = (5 - dow + 7) % 7;
  const day = 1 + daysToFirstFriday + 14; // first Friday + 14 = third Friday
  return new Date(Date.UTC(year, month1to12 - 1, day)).toISOString().slice(0, 10);
}

export function monthDeadline(year: number, month1to12: number): string {
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const nextYear = month1to12 === 12 ? year + 1 : year;
  return thirdFriday(nextYear, nextMonth);
}

// =====================================================================
// Reporting period
// =====================================================================

/**
 * The hospital form's `month_reporting` is a numeric code where 1 = Jan 2025
 * (confirmed by the data dictionary). Convert to our "YYYY-MM" period.
 */
export function monthCodeToPeriod(code: unknown, anchorYear = 2025, anchorMonth = 1): string | null {
  const c = toNum(code);
  if (!Number.isFinite(c) || c < 1) return null;
  const zeroBased = anchorMonth - 1 + (c - 1);
  const year = anchorYear + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The patient form's reporting period comes from delivery_date_1 (YYYY-MM). */
export function patientPeriod(row: RedcapRow): string | null {
  const d = row[PATIENT_DELIVERY_FIELD];
  if (!isValidDate(d)) return null;
  return String(d).trim().slice(0, 7);
}

// =====================================================================
// Patient eligibility (derived, per CPCQC)
// =====================================================================

export function patientEligible(row: RedcapRow, mode: EligibilityMode = 'derived'): boolean {
  const val = toNum(row[ELIGIBILITY_FIELD]);
  const explicit = val === ELIGIBLE_VALUE;
  const ineligible = val === INELIGIBLE_VALUE;
  const qualifying = QUALIFYING_SUBSTANCE_CODES.some(
    (c) => String(row[`substances_used_2___${c}`] ?? '').trim() === '1',
  );
  const derived = qualifying && !ineligible;
  if (mode === 'explicit') return explicit;
  if (mode === 'either') return explicit || derived;
  return derived;
}

// =====================================================================
// Completeness — report-level required fields
// =====================================================================

export interface CompletenessResult {
  complete: boolean;
  missing: string[];
}

/** Required fields (from REDCap metadata, @HIDDEN + excludes already removed)
 *  must all be non-blank on the hospital row. */
export function checkCompleteness(row: RedcapRow, requiredFields: string[]): CompletenessResult {
  const missing = requiredFields.filter((f) => f in row && !isFieldFilled(row[f]));
  return { complete: missing.length === 0, missing };
}

// =====================================================================
// Cross-project linkage
// =====================================================================

/** Floor (pass/fail): positives > 0 requires ≥ 1 eligible patient form. */
export function linkageFloorMet(positiveScreens: number, patientForms: number): boolean {
  if (positiveScreens <= 0) return true; // NA → not a failure
  return patientForms >= 1;
}

/** Ideal (non-blocking): one patient form per positive screen. */
export function linkageIdealMet(positiveScreens: number, patientForms: number): boolean {
  if (positiveScreens <= 0) return true;
  return patientForms >= positiveScreens;
}

// =====================================================================
// Status classification → tracker category
// =====================================================================

export type TttSyncCategory =
  | 'counting' // Compliant (floor met, on time, complete)
  | 'below_ideal' // Compliant but patient forms < positives (still counts)
  | 'complete_late' // Complete + floor met but submitted after deadline
  | 'complete_nodate' // Complete + floor met, no submission timestamp (N/A timing)
  | 'incomplete' // required field blank OR linkage floor failed
  | 'not_submitted' // no report, deadline passed
  | 'pending'; // no report, window still open

export interface TttDecisionInput {
  submitted: boolean;
  deadlinePassed: boolean;
  onTime: boolean | null; // null = submitted but no timestamp
  complete: boolean;
  missing: string[];
  linkageFloor: boolean;
  linkageIdeal: boolean;
  positiveScreens: number;
  patientForms: number;
}

export interface TttDecision {
  category: TttSyncCategory;
  reasons: string[];
  shortfall: number;
}

/** Roll the axes into a single category + human-readable reasons. Only the
 *  linkage FLOOR affects pass/fail; the IDEAL is a non-blocking note. */
export function classifyTtt(d: TttDecisionInput): TttDecision {
  const shortfall = d.positiveScreens > 0 ? Math.max(d.positiveScreens - d.patientForms, 0) : 0;

  if (!d.submitted) {
    return d.deadlinePassed
      ? { category: 'not_submitted', reasons: ['No report submitted; deadline passed.'], shortfall: 0 }
      : { category: 'pending', reasons: ['Reporting window still open.'], shortfall: 0 };
  }

  const failing: string[] = [];
  const reasons: string[] = [];
  if (!d.complete) {
    failing.push('incomplete');
    reasons.push(`Missing fields: ${d.missing.join(', ') || 'required field blank'}.`);
  }
  if (!d.linkageFloor) {
    failing.push('linkage');
    reasons.push(`${d.positiveScreens} positive screen(s) but ${d.patientForms} eligible patient form(s).`);
  }

  if (failing.length > 0) {
    // Any hard failure → needs revision. Note lateness in the reasons.
    if (d.onTime === false) reasons.push('Submitted after deadline.');
    return { category: 'incomplete', reasons, shortfall };
  }

  // Floor met + complete. Timeliness decides on_time / late / N/A.
  if (d.onTime === false) {
    return { category: 'complete_late', reasons: ['Complete + linkage met, but submitted after deadline.'], shortfall };
  }
  if (d.onTime === null) {
    return {
      category: 'complete_nodate',
      reasons: ['Complete + linkage met; no submission timestamp (timeliness N/A).'],
      shortfall,
    };
  }
  if (!d.linkageIdeal) {
    return {
      category: 'below_ideal',
      reasons: [`Floor met; short of the ideal by ${shortfall} patient form(s). Still counts.`],
      shortfall,
    };
  }
  return { category: 'counting', reasons: ['Submitted, timely, complete, linkage met. Counts.'], shortfall };
}
