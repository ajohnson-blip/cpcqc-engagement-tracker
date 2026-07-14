/**
 * NEST engagement logic — TypeScript port of Luis Montes' (CHA) NEST module.
 * Pure, dependency-free, unit-tested. Mirrors SPARK's shape but adapts to NEST:
 *   - MONTHLY cadence (deadline = 2nd Friday of the FOLLOWING month).
 *   - TWO repeating instruments per hospital-month (safe_sleep_audit + chart_reviews),
 *     one row per infant / chart.
 *   - Period comes from redcap_event_name (january_2026_arm_1 → "2026-01").
 *   - "Data complete" = BOTH forms submitted AND every submitted row passes its
 *     per-row completeness check.
 *
 * NOTE vs Luis's reference: his shipped logic module defines the per-row check
 * functions twice, and the second (active) copies silently drop the `race` and
 * `notcompliant_reasons` checkbox requirements. We follow the METHODOLOGY (those
 * checkboxes ARE required), so our completeness is the stricter, correct one.
 */

export const F_RECORD_ID = 'record_id';
export const F_EVENT = 'redcap_event_name';
export const F_DAG = 'redcap_data_access_group';
export const F_REPEAT_INSTRUMENT = 'redcap_repeat_instrument';
export const F_SSP_DATE = 'data_entry_date_ssp';
export const F_CHART_DATE = 'data_entry_date';

export const SSP_FORM = 'safe_sleep_audit';
export const CHART_FORM = 'chart_reviews';

export type RedcapRow = Record<string, string | null | undefined>;

// =====================================================================
// Deadlines — 2nd Friday of the month AFTER the reporting month
// =====================================================================

/** 2nd Friday of the given month, as an ISO date string (UTC, date-only). */
export function secondFriday(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const dow = first.getUTCDay(); // 0=Sun … 5=Fri … 6=Sat
  const daysToFirstFriday = (5 - dow + 7) % 7;
  const day = 1 + daysToFirstFriday + 7; // first Friday + 7 = second Friday
  return new Date(Date.UTC(year, month1to12 - 1, day)).toISOString().slice(0, 10);
}

/** Deadline for a reporting month = 2nd Friday of the following month. */
export function monthDeadline(year: number, month1to12: number): string {
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const nextYear = month1to12 === 12 ? year + 1 : year;
  return secondFriday(nextYear, nextMonth);
}

// =====================================================================
// Event → reporting period
// =====================================================================

const EVENT_TO_MONTH: Record<string, number> = {
  january_2026_arm_1: 1,
  february_2026_arm_1: 2,
  march_2026_arm_1: 3,
  april_2026_arm_1: 4,
  may_2026_arm_1: 5,
  june_2026_arm_1: 6,
  july_2026_arm_1: 7,
  aug_2026_arm_1: 8,
  sept_2026_arm_1: 9,
  oct_2026_arm_1: 10,
  nov_2026_arm_1: 11,
  dec_2026_arm_1: 12,
};

/** Event name → our period key "YYYY-MM", or null for non-monthly events
 *  (baseline_* / readiness_* — those feed the readiness assessment, not data). */
export function eventToPeriod(eventName: string | null | undefined): string | null {
  if (!eventName) return null;
  const ev = eventName.trim().toLowerCase();
  const m = EVENT_TO_MONTH[ev];
  if (!m) return null;
  // All 2026 events; the year is encoded in the slug (…_2026_arm_1).
  const yearMatch = ev.match(/_(\d{4})_arm/);
  const year = yearMatch ? parseInt(yearMatch[1]!, 10) : 2026;
  return `${year}-${String(m).padStart(2, '0')}`;
}

// =====================================================================
// Required fields (per the methodology)
// =====================================================================

// Safe Sleep Audit. safe_sleep_unit / reporting_month are @HIDDEN → excluded.
const SSP_ALWAYS = ['compliant_ssp'];
const SSP_NONCOMPLIANT_FIELDS = ['noncomp_addressed'];
const SSP_NONCOMPLIANT_CHECKBOX = 'notcompliant_reasons';

// Chart Review. infant_discharge_unit / reporting_month_chart are @HIDDEN → excluded.
const CHART_CHECKBOX = 'race';
const CHART_ALWAYS = [
  'ethnicity',
  'language',
  'payor',
  'ss_education_doc',
  'ss_screening_doc',
  'ss_resources_doc',
];
const CHART_IF_SCREENING = ['homeneeds_doc']; // required when ss_screening_doc = 1
const CHART_IF_HOMENEEDS = ['referral_resource_doc']; // required when homeneeds_doc = 1

// =====================================================================
// Helpers
// =====================================================================

export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

/** A date field is usable only when it's a real ISO date. Corrupt entries (junk
 *  typed into the field) must not be treated as a submission date. */
export function isValidDate(value: unknown): boolean {
  if (!isFieldFilled(value)) return false;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** REDCap exports checkboxes as `field___1`, `field___2`, … — "filled" = any ≥1 checked. */
export function isCheckboxFilled(row: RedcapRow, prefix: string): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith(`${prefix}___`) && String(v ?? '').trim() === '1') return true;
  }
  return false;
}

export interface RowCheck {
  complete: boolean;
  missing: string[];
}

export function checkSspRow(row: RedcapRow): RowCheck {
  const missing: string[] = [];
  for (const f of SSP_ALWAYS) if (!isFieldFilled(row[f])) missing.push(f);
  // When not compliant, the reason checkbox + "addressed" field are required.
  if (String(row['compliant_ssp'] ?? '').trim() === '0') {
    for (const f of SSP_NONCOMPLIANT_FIELDS) if (!isFieldFilled(row[f])) missing.push(f);
    if (!isCheckboxFilled(row, SSP_NONCOMPLIANT_CHECKBOX)) missing.push(SSP_NONCOMPLIANT_CHECKBOX);
  }
  return { complete: missing.length === 0, missing };
}

export function checkChartRow(row: RedcapRow): RowCheck {
  const missing: string[] = [];
  if (!isCheckboxFilled(row, CHART_CHECKBOX)) missing.push(CHART_CHECKBOX);
  for (const f of CHART_ALWAYS) if (!isFieldFilled(row[f])) missing.push(f);
  if (String(row['ss_screening_doc'] ?? '').trim() === '1') {
    for (const f of CHART_IF_SCREENING) if (!isFieldFilled(row[f])) missing.push(f);
  }
  if (String(row['homeneeds_doc'] ?? '').trim() === '1') {
    for (const f of CHART_IF_HOMENEEDS) if (!isFieldFilled(row[f])) missing.push(f);
  }
  return { complete: missing.length === 0, missing };
}

// =====================================================================
// Hospital-month aggregation
// =====================================================================

export interface FormRollup {
  submitted: boolean;
  nRows: number;
  nComplete: number;
  pctComplete: number;
  allComplete: boolean;
  earliestDate: string | null;
  /** True when a row's date field held a value that wasn't a valid date. */
  invalidDate: boolean;
}

function rollup(rows: RedcapRow[], check: (r: RedcapRow) => RowCheck, dateField: string): FormRollup {
  if (rows.length === 0) {
    return { submitted: false, nRows: 0, nComplete: 0, pctComplete: 0, allComplete: false, earliestDate: null, invalidDate: false };
  }
  const nComplete = rows.reduce((n, r) => n + (check(r).complete ? 1 : 0), 0);
  const filled = rows.map((r) => String(r[dateField] ?? '').trim()).filter((d) => d !== '');
  const valid = filled.filter((d) => isValidDate(d)).sort();
  return {
    submitted: true,
    nRows: rows.length,
    nComplete,
    pctComplete: Math.round((nComplete / rows.length) * 1000) / 10,
    allComplete: nComplete === rows.length,
    earliestDate: valid[0] ?? null,
    invalidDate: valid.length < filled.length,
  };
}

export interface NestCell {
  dagCode: string;
  period: string; // "2026-03"
  ssp: FormRollup;
  chart: FormRollup;
  bothSubmitted: boolean;
  dataComplete: boolean; // both submitted AND all rows of both forms complete
  earliestSubmissionDate: string | null;
  /** A row on either form had a filled-but-invalid date field. */
  invalidDate: boolean;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  deadline: string;
}

function dayDiff(aIso: string, bIso: string): number {
  return Math.round((Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${bIso}T00:00:00Z`)) / 86400000);
}

export interface BuildGridOptions {
  ignoreDags?: string[];
}

/**
 * Collapse the raw NEST export into one cell per (DAG, month). Only rows on the
 * two repeating data instruments are considered; baseline/readiness rows are
 * dropped (handled separately). Keyed by `${dagCode}::${period}`.
 */
export function buildNestGrid(rows: RedcapRow[], opts: BuildGridOptions = {}): Map<string, NestCell> {
  const ignore = new Set(opts.ignoreDags ?? ['test', 'test_2']);
  const groups = new Map<string, { ssp: RedcapRow[]; chart: RedcapRow[] }>();

  for (const row of rows) {
    const dag = String(row[F_DAG] ?? '').trim();
    if (!dag || ignore.has(dag)) continue;
    const period = eventToPeriod(row[F_EVENT]);
    if (!period) continue;
    const instrument = String(row[F_REPEAT_INSTRUMENT] ?? '').trim();
    if (instrument !== SSP_FORM && instrument !== CHART_FORM) continue;
    const key = `${dag}::${period}`;
    if (!groups.has(key)) groups.set(key, { ssp: [], chart: [] });
    if (instrument === SSP_FORM) groups.get(key)!.ssp.push(row);
    else groups.get(key)!.chart.push(row);
  }

  const out = new Map<string, NestCell>();
  for (const [key, g] of groups) {
    const [dagCode, period] = key.split('::') as [string, string];
    const [year, month] = period.split('-').map((n) => parseInt(n, 10)) as [number, number];
    const ssp = rollup(g.ssp, checkSspRow, F_SSP_DATE);
    const chart = rollup(g.chart, checkChartRow, F_CHART_DATE);
    const bothSubmitted = ssp.submitted && chart.submitted;
    const dataComplete = bothSubmitted && ssp.allComplete && chart.allComplete;
    const candidateDates = [ssp.earliestDate, chart.earliestDate].filter(
      (d): d is string => d !== null,
    );
    const earliest = candidateDates.length ? candidateDates.sort()[0]! : null;
    const deadline = monthDeadline(year, month);
    const days = earliest ? dayDiff(earliest, deadline) : null;
    out.set(key, {
      dagCode,
      period,
      ssp,
      chart,
      bothSubmitted,
      dataComplete,
      earliestSubmissionDate: earliest,
      invalidDate: ssp.invalidDate || chart.invalidDate,
      onTime: days === null ? null : days <= 0,
      daysFromDeadline: days,
      deadline,
    });
  }
  return out;
}
