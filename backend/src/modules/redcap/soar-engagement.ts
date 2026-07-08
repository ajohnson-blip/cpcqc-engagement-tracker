/**
 * SOAR engagement logic — TypeScript port of Luis Montes' (CHA) SOAR module.
 * Pure, dependency-free, unit-tested. Mirrors NEST's shape but adapts to SOAR:
 *   - MONTHLY, previous-month reporting (deadline = 3rd Friday of the FOLLOWING month).
 *   - PATIENT-LEVEL data: one row per NTSV cesarean on the ntsv_cesarean_section
 *     repeating instrument (NOT aggregate counts).
 *   - NO-NTSV ATTESTATION: a separate no_ntsv_csections form lets zero-case months
 *     count as a complete submission so low-volume hospitals aren't penalized.
 *   - BRANCHING completeness: required fields depend on admit_reason (induction
 *     path) and c_sect_indication_primary (failed induction / arrest of dilation /
 *     arrest of descent each add their own required fields).
 *   - This is a CLASSIC repeating-instruments project (not longitudinal): the
 *     reporting month comes from delivery_date (NTSV) or month_year_nontsv
 *     (No-NTSV), NOT from redcap_event_name.
 *
 * "Data complete" for a hospital-month:
 *   - If ≥1 NTSV case row: EVERY NTSV row must pass its branching-logic check.
 *   - Else if ≥1 No-NTSV attestation: the attestation row(s) must be complete.
 *   - Else: not complete (nothing submitted).
 */

export const F_DAG = 'redcap_data_access_group';
export const F_REPEAT_INSTRUMENT = 'redcap_repeat_instrument';
/** @TODAY submission-date field, present on both the NTSV and No-NTSV forms. */
export const F_SUBMIT_DATE = 'date';

export const NTSV_FORM = 'ntsv_cesarean_section';
export const NO_NTSV_FORM = 'no_ntsv_csections';

export type RedcapRow = Record<string, string | null | undefined>;

// =====================================================================
// Deadlines — 3rd Friday of the month AFTER the reporting month
// =====================================================================

/** 3rd Friday of the given month, as an ISO date string (UTC, date-only). */
export function thirdFriday(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const dow = first.getUTCDay(); // 0=Sun … 5=Fri … 6=Sat
  const daysToFirstFriday = (5 - dow + 7) % 7;
  const day = 1 + daysToFirstFriday + 14; // first Friday + 14 = third Friday
  return new Date(Date.UTC(year, month1to12 - 1, day)).toISOString().slice(0, 10);
}

/** Deadline for a reporting month = 3rd Friday of the following month. */
export function monthDeadline(year: number, month1to12: number): string {
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const nextYear = month1to12 === 12 ? year + 1 : year;
  return thirdFriday(nextYear, nextMonth);
}

// =====================================================================
// Required fields (per the methodology; @HIDDEN fields already excluded)
// =====================================================================

// --- NTSV Cesarean Section: always required (6 fields + admit_reason checkbox) ---
const NTSV_ALWAYS = [
  'checklist_comms_tool',
  'who_managed_labor_2',
  'age',
  'delivery_date',
  'gest_age',
  'c_sect_indication_primary',
];
const NTSV_ADMIT_CHECKBOX = 'admit_reason';

// --- Conditional: admit_reason includes "4" (For induction) ---
const NTSV_INDUCTION_REASON = 'induction_reason';
const NTSV_INDUCTION_METHOD = 'induction_method';

// --- Conditional on c_sect_indication_primary ---
const NTSV_COND_FAILED_INDUCTION = [
  'failed_induct_rupt_mem_y_n',
  'failed_induction_y_n',
  'fail_induct_six_cm_dil',
]; // primary == "1"
const NTSV_COND_ARREST_DILATION = [
  'arrest_dil_six_cm_dil',
  'arrest_dil_rupt_mem',
  'adequate_contraction',
  'iupc_placed_y_n',
]; // primary == "2"
const NTSV_COND_ARREST_DESCENT = ['push_3hours', 'op_vag_delivery']; // primary == "3"

// --- No-NTSV attestation ---
const NO_NTSV_MONTH_FIELD = 'month_year_nontsv';
const NO_NTSV_CHECKBOX = 'self_report_nontsv';

// =====================================================================
// Helpers
// =====================================================================

export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

/** REDCap exports checkboxes as `field___1`, `field___2`, … — "filled" = any ≥1 checked. */
export function isCheckboxFilled(row: RedcapRow, prefix: string): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith(`${prefix}___`) && String(v ?? '').trim() === '1') return true;
  }
  return false;
}

/** Is a specific checkbox option selected? (e.g. admit_reason option "4"). */
export function checkboxIncludes(row: RedcapRow, prefix: string, option: string): boolean {
  return String(row[`${prefix}___${option}`] ?? '').trim() === '1';
}

export interface RowCheck {
  complete: boolean;
  missing: string[];
}

/** Full branching-logic completeness for one NTSV cesarean row. */
export function checkNtsvRow(row: RedcapRow): RowCheck {
  const missing: string[] = [];
  for (const f of NTSV_ALWAYS) if (!isFieldFilled(row[f])) missing.push(f);

  // admit_reason: always-required checkbox.
  if (!isCheckboxFilled(row, NTSV_ADMIT_CHECKBOX)) missing.push(NTSV_ADMIT_CHECKBOX);

  // If admitted "For induction" (option 4), induction detail checkboxes are required.
  if (checkboxIncludes(row, NTSV_ADMIT_CHECKBOX, '4')) {
    if (!isCheckboxFilled(row, NTSV_INDUCTION_REASON)) missing.push(NTSV_INDUCTION_REASON);
    if (!isCheckboxFilled(row, NTSV_INDUCTION_METHOD)) missing.push(NTSV_INDUCTION_METHOD);
  }

  // Primary indication branching.
  const primary = String(row['c_sect_indication_primary'] ?? '').trim();
  const cond =
    primary === '1'
      ? NTSV_COND_FAILED_INDUCTION
      : primary === '2'
        ? NTSV_COND_ARREST_DILATION
        : primary === '3'
          ? NTSV_COND_ARREST_DESCENT
          : [];
  for (const f of cond) if (!isFieldFilled(row[f])) missing.push(f);

  return { complete: missing.length === 0, missing };
}

/** Completeness for a No-NTSV (zero-case) attestation row. */
export function checkNoNtsvRow(row: RedcapRow): RowCheck {
  const missing: string[] = [];
  if (!isFieldFilled(row[NO_NTSV_MONTH_FIELD])) missing.push(NO_NTSV_MONTH_FIELD);
  if (!isCheckboxFilled(row, NO_NTSV_CHECKBOX)) missing.push(NO_NTSV_CHECKBOX);
  return { complete: missing.length === 0, missing };
}

// =====================================================================
// Reporting-month extraction
// =====================================================================

/** Pull {year, month} from an ISO-ish date string ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM"). */
export function parseYearMonth(dateStr: unknown): { year: number; month: number } | null {
  if (!isFieldFilled(dateStr)) return null;
  const s = String(dateStr).trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return { year: parseInt(m[1]!, 10), month: parseInt(m[2]!, 10) };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** NTSV reporting month comes from delivery_date. */
export function ntsvMonth(row: RedcapRow): { year: number; month: number } | null {
  return parseYearMonth(row['delivery_date']);
}

/** No-NTSV reporting month = month_year_nontsv dropdown (1–12) in the given year. */
export function noNtsvMonth(row: RedcapRow, year: number): { year: number; month: number } | null {
  const raw = row[NO_NTSV_MONTH_FIELD];
  if (!isFieldFilled(raw)) return null;
  const m = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  return { year, month: m };
}

/** Classify a raw row by repeat instrument, with a field-presence fallback. */
export function classifyRow(row: RedcapRow): 'ntsv' | 'no_ntsv' | 'other' {
  const instrument = String(row[F_REPEAT_INSTRUMENT] ?? '').trim();
  if (instrument === NTSV_FORM) return 'ntsv';
  if (instrument === NO_NTSV_FORM) return 'no_ntsv';
  if (isFieldFilled(row['c_sect_indication_primary'])) return 'ntsv';
  if (isFieldFilled(row[NO_NTSV_MONTH_FIELD])) return 'no_ntsv';
  return 'other';
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
}

function rollup(rows: RedcapRow[], check: (r: RedcapRow) => RowCheck): FormRollup {
  if (rows.length === 0) {
    return { submitted: false, nRows: 0, nComplete: 0, pctComplete: 0, allComplete: false, earliestDate: null };
  }
  const nComplete = rows.reduce((n, r) => n + (check(r).complete ? 1 : 0), 0);
  const dates = rows
    .map((r) => (isFieldFilled(r[F_SUBMIT_DATE]) ? String(r[F_SUBMIT_DATE]).trim() : null))
    .filter((d): d is string => d !== null)
    .sort();
  return {
    submitted: true,
    nRows: rows.length,
    nComplete,
    pctComplete: Math.round((nComplete / rows.length) * 1000) / 10,
    allComplete: nComplete === rows.length,
    earliestDate: dates[0] ?? null,
  };
}

export interface SoarCell {
  dagCode: string;
  period: string; // "2026-03"
  ntsv: FormRollup;
  noNtsv: FormRollup;
  /** True when the ONLY submission is a valid No-NTSV (zero-case) attestation. */
  attestationOnly: boolean;
  submitted: boolean;
  dataComplete: boolean;
  /** NTSV rows whose delivery_date is after "today" — likely typos. */
  futureDated: number;
  earliestSubmissionDate: string | null;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  deadline: string;
}

function dayDiff(aIso: string, bIso: string): number {
  return Math.round((Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${bIso}T00:00:00Z`)) / 86400000);
}

export interface BuildGridOptions {
  /** Reporting year used to resolve No-NTSV month dropdowns. Default 2026. */
  year?: number;
  /** DAGs to drop entirely (test groups). */
  ignoreDags?: string[];
  /** ISO date; NTSV rows dated after this are counted as `futureDated`. */
  todayIso?: string;
}

/**
 * Collapse the raw SOAR export into one cell per (DAG, month). NTSV rows are
 * bucketed by delivery_date, No-NTSV attestations by their month dropdown.
 * Readiness/base rows are ignored. Keyed by `${dagCode}::${period}`.
 */
export function buildSoarGrid(rows: RedcapRow[], opts: BuildGridOptions = {}): Map<string, SoarCell> {
  const year = opts.year ?? 2026;
  const ignore = new Set(opts.ignoreDags ?? ['test', '']);
  const groups = new Map<string, { ntsv: RedcapRow[]; noNtsv: RedcapRow[] }>();

  for (const row of rows) {
    const dag = String(row[F_DAG] ?? '').trim();
    if (ignore.has(dag)) continue;
    const kind = classifyRow(row);
    let ym: { year: number; month: number } | null = null;
    if (kind === 'ntsv') ym = ntsvMonth(row);
    else if (kind === 'no_ntsv') ym = noNtsvMonth(row, year);
    else continue;
    if (!ym) continue;
    const period = `${ym.year}-${String(ym.month).padStart(2, '0')}`;
    const key = `${dag}::${period}`;
    if (!groups.has(key)) groups.set(key, { ntsv: [], noNtsv: [] });
    if (kind === 'ntsv') groups.get(key)!.ntsv.push(row);
    else groups.get(key)!.noNtsv.push(row);
  }

  const out = new Map<string, SoarCell>();
  for (const [key, g] of groups) {
    const [dagCode, period] = key.split('::') as [string, string];
    const [pYear, pMonth] = period.split('-').map((n) => parseInt(n, 10)) as [number, number];
    const ntsv = rollup(g.ntsv, checkNtsvRow);
    const noNtsv = rollup(g.noNtsv, checkNoNtsvRow);

    // Data-complete precedence: real cases must all pass; else the attestation.
    const dataComplete = ntsv.submitted ? ntsv.allComplete : noNtsv.submitted ? noNtsv.allComplete : false;
    const submitted = ntsv.submitted || noNtsv.submitted;
    const attestationOnly = !ntsv.submitted && noNtsv.submitted;

    const futureDated = opts.todayIso
      ? g.ntsv.reduce((n, r) => {
          const d = isFieldFilled(r['delivery_date']) ? String(r['delivery_date']).trim().slice(0, 10) : null;
          return n + (d && d > opts.todayIso! ? 1 : 0);
        }, 0)
      : 0;

    const candidateDates = [ntsv.earliestDate, noNtsv.earliestDate].filter((d): d is string => d !== null);
    const earliest = candidateDates.length ? candidateDates.sort()[0]! : null;
    const deadline = monthDeadline(pYear, pMonth);
    const days = earliest ? dayDiff(earliest, deadline) : null;

    out.set(key, {
      dagCode,
      period,
      ntsv,
      noNtsv,
      attestationOnly,
      submitted,
      dataComplete,
      futureDated,
      earliestSubmissionDate: earliest,
      onTime: days === null ? null : days <= 0,
      daysFromDeadline: days,
      deadline,
    });
  }
  return out;
}
