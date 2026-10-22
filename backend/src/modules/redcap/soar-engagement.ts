/**
 * SOAR engagement logic — TypeScript port of Luis Montes' (CHA) SOAR module.
 * Pure, dependency-free, unit-tested. Mirrors NEST's shape but adapts to SOAR:
 *   - MONTHLY, previous-month reporting (deadline = 2nd Friday of the FOLLOWING month).
 *   - PATIENT-LEVEL data: one row per NTSV cesarean on the ntsv_cesarean_section
 *     repeating instrument (NOT aggregate counts).
 *   - NO-NTSV ATTESTATION: a separate no_ntsv_csections form lets zero-case months
 *     count as a complete submission so low-volume hospitals aren't penalized.
 *   - BRANCHING completeness: required fields depend on admit_reason (induction
 *     path) and c_sect_indication_primary (failed induction / arrest of dilation /
 *     arrest of descent each add their own required fields).
 *   - This is a CLASSIC repeating-instruments project (not longitudinal): the
 *     reporting month comes from delivery_date (NTSV) or month_year_nontsv
 *     (No-NTSV), NOT from redcap_event_name. month_year_nontsv codes carry the
 *     year as well as the month — see attestationPeriodsFromDictionary.
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

/** Deadline for a reporting month = 2nd Friday of the following month (CPCQC's
 *  2026 SOAR schedule; matches the deadline sheet for Jun 2026 onward). */
export function monthDeadline(year: number, month1to12: number): string {
  const nextMonth = month1to12 === 12 ? 1 : month1to12 + 1;
  const nextYear = month1to12 === 12 ? year + 1 : year;
  return secondFriday(nextYear, nextMonth);
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

/**
 * The only fields the SOAR sync needs — HIPAA minimum necessary.
 *
 * Derived from the required-field lists above rather than written out again:
 * a field added to the completeness check must also be retrieved, and a
 * hand-maintained second list would eventually miss one and silently mark
 * every row incomplete.
 *
 * Note this DOES include `age`, `delivery_date` and `gest_age`. The sync never
 * reads their values, but completeness means "non-empty", and REDCap has no
 * way to ask whether a field is filled without returning it. What it drops is
 * the surplus: free-text fields like `admit_other` and `op_vag_birth_exp`,
 * where identifying narrative is most likely to be typed.
 *
 * Pass as `fields` WITHOUT `forms` — REDCap unions named fields with every
 * field on a named form, so sending both restricts nothing. Checkbox base
 * names expand to their `___<code>` columns.
 */
export const SOAR_MINIMUM_FIELDS: string[] = [
  F_SUBMIT_DATE,
  ...NTSV_ALWAYS,
  NTSV_ADMIT_CHECKBOX,
  NTSV_INDUCTION_REASON,
  NTSV_INDUCTION_METHOD,
  ...NTSV_COND_FAILED_INDUCTION,
  ...NTSV_COND_ARREST_DILATION,
  ...NTSV_COND_ARREST_DESCENT,
  NO_NTSV_MONTH_FIELD,
  NO_NTSV_CHECKBOX,
];

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

// =====================================================================
// No-NTSV attestation periods — read from the data dictionary
// =====================================================================

/**
 * `month_year_nontsv` codes name a month AND a year: 1–12 are January–December
 * 2026, and later years continue consecutively (13 = January 2027), the same
 * pattern as TtT's monthly form. Per CHA, confirmed in the data dictionary.
 *
 * The dictionary's labels decide what each code means, and every label must
 * agree with that pattern. Relabelling 1–12 as 2027 instead of adding codes
 * would otherwise move a whole year's attestations into the wrong year without
 * a sound, so a label that disagrees stops the sync instead. An attestation
 * whose code the dictionary does not define is flagged, never guessed.
 */
const FIRST_CODE_YEAR = 2026;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** A dropdown code as REDCap stores it: "07" and "7" are the same code. */
function normaliseCode(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  return /^\d+$/.test(s) ? String(parseInt(s, 10)) : null;
}

/** The period a code means under the consecutive pattern: 1 → "2026-01", 13 → "2027-01". */
export function attestationCodePeriod(code: number): string {
  const zeroBased = code - 1;
  const year = FIRST_CODE_YEAR + Math.floor(zeroBased / 12);
  return `${year}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

/** "January 2026" → "2026-01". Full or three-letter month names; null if either part is missing. */
export function periodFromLabel(label: string): string | null {
  const text = label.replace(/<[^>]*>/g, ' ').toLowerCase();
  const year = /\b(20\d{2})\b/.exec(text)?.[1];
  const words = text.match(/[a-z]+/g) ?? [];
  const month = MONTH_NAMES.findIndex((name) => words.some((w) => w.length >= 3 && name.startsWith(w)));
  if (!year || month < 0) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** REDCap's `select_choices_or_calculations`: "1, January 2026 | 2, February 2026". */
export function parseChoices(raw: unknown): Array<{ code: string; label: string }> {
  return String(raw ?? '')
    .split('|')
    .map((part) => {
      const i = part.indexOf(',');
      return i < 0 ? null : { code: part.slice(0, i).trim(), label: part.slice(i + 1).trim() };
    })
    .filter((c): c is { code: string; label: string } => c !== null && c.code !== '');
}

/**
 * Code → period for month_year_nontsv, from the SOAR data dictionary
 * (REDCap's metadata export). Throws, naming the code, when the field is
 * missing or a label does not follow the pattern — the sync must not run on a
 * mapping it cannot trust.
 */
export function attestationPeriodsFromDictionary(meta: Array<Record<string, unknown>>): Map<string, string> {
  const field = meta.find((m) => String(m['field_name'] ?? '').trim() === NO_NTSV_MONTH_FIELD);
  const choices = parseChoices(field?.['select_choices_or_calculations']);
  if (choices.length === 0) {
    throw new Error(`The SOAR data dictionary defines no codes for ${NO_NTSV_MONTH_FIELD}.`);
  }
  const periods = new Map<string, string>();
  for (const { code, label } of choices) {
    const n = normaliseCode(code);
    if (n === null || Number(n) < 1) {
      throw new Error(`${NO_NTSV_MONTH_FIELD} has a code, "${code}", that is not a positive whole number.`);
    }
    const expected = attestationCodePeriod(Number(n));
    const labelled = periodFromLabel(label);
    if (labelled !== expected) {
      throw new Error(
        `${NO_NTSV_MONTH_FIELD} code ${n} is labelled "${label}", but codes run consecutively from ` +
          `1 = January ${FIRST_CODE_YEAR}, so code ${n} should be ${expected}. Stopping rather than place ` +
          `attestations in the wrong month.`,
      );
    }
    periods.set(n, expected);
  }
  return periods;
}

/** No-NTSV reporting period from its month_year_nontsv code; null when blank or undefined. */
export function noNtsvPeriod(row: RedcapRow, periods: Map<string, string>): string | null {
  const code = normaliseCode(row[NO_NTSV_MONTH_FIELD]);
  return code === null ? null : (periods.get(code) ?? null);
}

/** Filled in, but with a code the data dictionary does not define. */
export function hasUndefinedAttestationCode(row: RedcapRow, periods: Map<string, string>): boolean {
  return isFieldFilled(row[NO_NTSV_MONTH_FIELD]) && noNtsvPeriod(row, periods) === null;
}

/** Classify a raw row by repeat instrument, with a field-presence fallback. */
export function classifyRow(row: RedcapRow): 'ntsv' | 'no_ntsv' | 'other' {
  const instrument = String(row[F_REPEAT_INSTRUMENT] ?? '').trim();
  if (instrument === NTSV_FORM) return 'ntsv';
  if (instrument === NO_NTSV_FORM) return 'no_ntsv';
  // Fallback for rows with no explicit repeat instrument — e.g. a base record
  // where fields from more than one instrument bleed onto the same row. Check
  // the No-NTSV field FIRST: a real NTSV case always has the repeat instrument
  // set, so a row that reaches this fallback with month_year_nontsv populated is
  // an attestation, even when a stray c_sect_indication_primary is also present.
  // (Per Luis Montes / CHA: Prowers' Feb zero-case attestation was being dropped
  // because the NTSV field was checked first.)
  if (isFieldFilled(row[NO_NTSV_MONTH_FIELD])) return 'no_ntsv';
  if (isFieldFilled(row['c_sect_indication_primary'])) return 'ntsv';
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
  /** True when a row's date field held a value that wasn't a valid date. */
  invalidDate: boolean;
  /**
   * Which rows were incomplete and what each was missing. Per-record rather
   * than a field tally, because "one record missing two things" and "two
   * records missing one thing each" are different problems: the first is an
   * abandoned entry, the second is a scattered gap. A count alone can't tell
   * them apart, and staff need the record id to find it in REDCap.
   */
  incompleteRows: Array<{ recordId: string; missing: string[] }>;
}

function rollup(rows: RedcapRow[], check: (r: RedcapRow) => RowCheck): FormRollup {
  if (rows.length === 0) {
    return { submitted: false, nRows: 0, nComplete: 0, pctComplete: 0, allComplete: false, earliestDate: null, invalidDate: false, incompleteRows: [] };
  }
  const nComplete = rows.reduce((n, r) => n + (check(r).complete ? 1 : 0), 0);
  // Identify each incomplete row so staff can open it in REDCap. Repeating
  // instruments reuse a record_id across instances, so the instance number is
  // part of the identity where present.
  const incompleteRows: Array<{ recordId: string; missing: string[] }> = [];
  for (const r of rows) {
    const res = check(r);
    if (res.complete) continue;
    const id = String(r['record_id'] ?? '').trim() || '(no record id)';
    const instance = String(r['redcap_repeat_instance'] ?? '').trim();
    incompleteRows.push({
      recordId: instance ? `${id} #${instance}` : id,
      missing: res.missing,
    });
  }

  const filled = rows.map((r) => String(r[F_SUBMIT_DATE] ?? '').trim()).filter((d) => d !== '');
  const valid = filled.filter((d) => isValidDate(d)).sort();
  return {
    submitted: true,
    nRows: rows.length,
    nComplete,
    pctComplete: Math.round((nComplete / rows.length) * 1000) / 10,
    allComplete: nComplete === rows.length,
    earliestDate: valid[0] ?? null,
    invalidDate: valid.length < filled.length,
    incompleteRows,
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
  /** A row on either form had a filled-but-invalid submission date. */
  invalidDate: boolean;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  deadline: string;
  /**
   * Set only when the cell came from CHA's assessment file, which sends
   * missing fields already grouped. The REDCap path leaves it undefined and
   * the sync derives groups from `incompleteRows` instead.
   */
  missingFieldGroups?: Array<{
    form: string;
    records: number;
    fields: Array<{ field: string; label: string }>;
  }>;
  /**
   * CHA's per-hospital diagnostics — future-dated cases, unusable submission
   * dates — as counts. The REDCap path reports the same through `futureDated`
   * and `invalidDate` and leaves this undefined.
   */
  notes?: string[];
}

export function dayDiff(aIso: string, bIso: string): number {
  return Math.round((Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${bIso}T00:00:00Z`)) / 86400000);
}

export interface BuildGridOptions {
  /**
   * month_year_nontsv code → period, from attestationPeriodsFromDictionary.
   * Required: the code says which year an attestation is for, so it is never
   * inferred from the year being synced.
   */
  attestationPeriods: Map<string, string>;
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
export function buildSoarGrid(rows: RedcapRow[], opts: BuildGridOptions): Map<string, SoarCell> {
  const ignore = new Set(opts.ignoreDags ?? ['test', '']);
  const groups = new Map<string, { ntsv: RedcapRow[]; noNtsv: RedcapRow[] }>();

  for (const row of rows) {
    const dag = String(row[F_DAG] ?? '').trim();
    if (ignore.has(dag)) continue;
    const kind = classifyRow(row);
    let period: string | null = null;
    if (kind === 'ntsv') {
      const ym = ntsvMonth(row);
      period = ym ? `${ym.year}-${String(ym.month).padStart(2, '0')}` : null;
    } else if (kind === 'no_ntsv') {
      // An undefined code leaves the attestation out; the sync reports it.
      period = noNtsvPeriod(row, opts.attestationPeriods);
    } else continue;
    if (!period) continue;
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
      invalidDate: ntsv.invalidDate || noNtsv.invalidDate,
      onTime: days === null ? null : days <= 0,
      daysFromDeadline: days,
      deadline,
    });
  }
  return out;
}
