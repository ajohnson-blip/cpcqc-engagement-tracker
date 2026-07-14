/**
 * SPARK engagement logic — TypeScript port of Luis Montes' (CHA) reference
 * module `spark_engagement_logic.py`. Pure, dependency-free, unit-tested.
 *
 * Three business rules, mirrored exactly from the source:
 *   1. COMPLETENESS = 56 always-required fields + 18 conditional IPV fields
 *      (the 18 are required only when ipv_screen_implemented == "1").
 *   2. TIMELINESS  = submission date <= 2nd Friday of the month after the quarter.
 *   3. QUARTER     = the most recent quarter that ended on/before the date.
 *
 * On top of the row-level functions, `buildSparkGrid` collapses the raw REDCap
 * export (a longitudinal project where each *_data_* EVENT is a quarter, and a
 * hospital may have several records/rows per quarter) into one result cell per
 * (DAG, quarter). The row-selection rule here is documented and conservative —
 * see pickPrimaryRow — and the grid flags hospitals that have competing records
 * so a PM/the data analyst can reconcile before anything counts officially.
 */

// REDCap structural field names (present on every flat export row).
export const F_RECORD_ID = 'record_id';
export const F_EVENT = 'redcap_event_name';
export const F_DAG = 'redcap_data_access_group';
export const F_DATE = 'date';
export const F_IPV_GATE = 'ipv_screen_implemented';

export type RedcapRow = Record<string, string | null | undefined>;

// =====================================================================
// Required-field definitions (verbatim from the reference module)
// =====================================================================

export const DENOM_FIELDS = [
  'denom_total',
  'denom_race_ai_an', 'denom_race_asian', 'denom_race_black',
  'denom_race_nh_pi', 'denom_race_me_northaf', 'denom_race_white',
  'denom_race_other', 'denom_race_unknown', 'denom_race_declined',
  'denom_eth_hisp', 'denom_eth_nonhisp', 'denom_eth_unknown',
  'denom_eth_declined',
  'denom_payor_medicaid', 'denom_payor_private',
  'denom_payor_public', 'denom_payor_unins',
];

export const SSDOH_FIELDS = [
  'ssdoh_total',
  'ssdoh_race_ai_an', 'ssdoh_race_asian', 'ssdoh_race_black',
  'ssdoh_me_northaf', 'ssdoh_race_nh_pi', 'ssdoh_race_white',
  'ssdoh_race_other', 'ssdoh_race_unknown', 'ssdoh_race_declined',
  'ssdoh_eth_hisp', 'ssdoh_eth_nonhisp', 'ssdoh_eth_unknown',
  'ssdoh_eth_declined',
  'ssdoh_payor_medicaid', 'ssdoh_payor_private',
  'ssdoh_payor_public', 'ssdoh_payor_unins',
];

export const PMHC_FIELDS = [
  'pmhc_total',
  'pmhc_race_ai_an', 'pmhc_race_asian', 'pmhc_race_black',
  'pmhc_me_northaf', 'pmhc_race_nh_pi', 'pmhc_race_white',
  'pmhc_race_other', 'pmhc_race_unknown', 'pmhc_race_declined',
  'pmhc_eth_hisp', 'pmhc_eth_nonhisp', 'pmhc_eth_unknown',
  'pmhc_eth_declined',
  'pmhc_payor_medicaid', 'pmhc_payor_private',
  'pmhc_payor_public', 'pmhc_payor_unins',
];

export const IPV_GATE = [F_IPV_GATE];

export const IPV_CONDITIONAL_FIELDS = [
  'ipv_total',
  'ipv_race_ai_an', 'ipv_race_asian', 'ipv_race_black',
  'ipv_me_northaf', 'ipv_race_nh_pi', 'ipv_race_white',
  'ipv_race_other', 'ipv_race_unknown', 'ipv_race_declined',
  'ipv_eth_hisp', 'ipv_eth_nonhisp', 'ipv_eth_unknown',
  'ipv_eth_declined',
  'ipv_payor_medicaid', 'ipv_payor_private',
  'ipv_payor_public', 'ipv_payor_unins',
];

export const WORKGROUP_FIELDS = ['multidisciplinary_meeting'];

/** 56 fields required of every submission. */
export const ALWAYS_REQUIRED = [
  ...DENOM_FIELDS, ...SSDOH_FIELDS, ...PMHC_FIELDS, ...IPV_GATE, ...WORKGROUP_FIELDS,
];

/** All 74 data fields — used to decide whether a row carries any data at all. */
export const ALL_DATA_FIELDS = [...ALWAYS_REQUIRED, ...IPV_CONDITIONAL_FIELDS];

// =====================================================================
// Deadline schedule (2nd Friday of the month after the quarter end)
// =====================================================================

/** 2nd Friday of the given month, as an ISO date string (UTC, date-only). */
export function secondFriday(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const dow = first.getUTCDay(); // 0=Sun … 5=Fri … 6=Sat
  const daysToFirstFriday = (5 - dow + 7) % 7;
  const day = 1 + daysToFirstFriday + 7; // first Friday + 7 = second Friday
  const d = new Date(Date.UTC(year, month1to12 - 1, day));
  return d.toISOString().slice(0, 10);
}

interface QuarterMeta {
  /** Our canonical period key, matching task_instances.period — e.g. "2026-Q1". */
  key: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  deadline: string; // YYYY-MM-DD
}

const QUARTER_END_MONTH: Record<1 | 2 | 3 | 4, number> = { 1: 3, 2: 6, 3: 9, 4: 12 };
const QUARTER_START_MONTH: Record<1 | 2 | 3 | 4, number> = { 1: 1, 2: 4, 3: 7, 4: 10 };

function lastDayOfMonth(year: number, month1to12: number): string {
  const d = new Date(Date.UTC(year, month1to12, 0)); // day 0 of next month
  return d.toISOString().slice(0, 10);
}

function quarterMeta(year: number, q: 1 | 2 | 3 | 4): QuarterMeta {
  const endMonth = QUARTER_END_MONTH[q];
  const startMonth = QUARTER_START_MONTH[q];
  const deadlineMonth = q === 4 ? 1 : endMonth + 1;
  const deadlineYear = q === 4 ? year + 1 : year;
  return {
    key: `${year}-Q${q}`,
    periodStart: `${year}-${String(startMonth).padStart(2, '0')}-01`,
    periodEnd: lastDayOfMonth(year, endMonth),
    deadline: secondFriday(deadlineYear, deadlineMonth),
  };
}

/** Deadline schedule covering 2025–2028, keyed by "YYYY-Qn". */
export const DEADLINES: Record<string, QuarterMeta> = (() => {
  const out: Record<string, QuarterMeta> = {};
  for (let year = 2025; year <= 2028; year++) {
    for (const q of [1, 2, 3, 4] as const) {
      const m = quarterMeta(year, q);
      out[m.key] = m;
    }
  }
  return out;
})();

// =====================================================================
// Event → quarter mapping
// =====================================================================

/**
 * REDCap longitudinal event slugs encode the data period. Confirmed slugs are
 * listed explicitly; the parser handles future quarters whose slug follows the
 * same `<monthrange>_<yy>` shape (e.g. aprjun_26 → 2026-Q2). HRA/assessment
 * events (baseline_*, self_assessment_*) intentionally return null — they are
 * not quarterly data submissions.
 */
const EXPLICIT_EVENT_QUARTER: Record<string, string> = {
  julysept_25_data_p_arm_1: '2025-Q3',
  octdec_25_data_arm_1: '2025-Q4',
  janmar_26_data_arm_1: '2026-Q1',
  aprjune_26_data_arm_1: '2026-Q2',
};

// REDCap's month-range slugs are inconsistent: Q1/Q3/Q4 abbreviate (janmar,
// julysept, octdec) but the 2026 Q2 event spells out "june" (aprjune, not
// aprjun). Accept both forms so the parser doesn't silently drop Q2 data.
const MONTHRANGE_TO_Q: Record<string, 1 | 2 | 3 | 4> = {
  janmar: 1,
  aprjune: 2,
  aprjun: 2,
  julysept: 3,
  octdec: 4,
};

export function eventToQuarter(eventName: string | null | undefined): string | null {
  if (!eventName) return null;
  const ev = eventName.trim();
  if (ev in EXPLICIT_EVENT_QUARTER) return EXPLICIT_EVENT_QUARTER[ev]!;
  // Only *_data* events are quarterly submissions. Longer month-range alternates
  // (aprjune) must precede their prefixes (aprjun) so the regex matches greedily.
  if (!/_data/.test(ev)) return null;
  const m = ev.match(/^(janmar|aprjune|aprjun|julysept|octdec)_(\d{2})/);
  if (!m) return null;
  const q = MONTHRANGE_TO_Q[m[1]!]!;
  const year = 2000 + parseInt(m[2]!, 10);
  return `${year}-Q${q}`;
}

// =====================================================================
// Row-level helpers
// =====================================================================

export function isFieldFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value).trim() !== '';
}

export function rowHasData(row: RedcapRow): boolean {
  return ALL_DATA_FIELDS.some((f) => isFieldFilled(row[f]));
}

/** Count of required fields that are filled on a row (used for tie-breaking). */
function filledRequiredCount(row: RedcapRow): number {
  const required = requiredFieldsFor(row);
  return required.reduce((n, f) => n + (isFieldFilled(row[f]) ? 1 : 0), 0);
}

function requiredFieldsFor(row: RedcapRow): string[] {
  const required = [...ALWAYS_REQUIRED];
  if (String(row[F_IPV_GATE] ?? '').trim() === '1') required.push(...IPV_CONDITIONAL_FIELDS);
  return required;
}

export interface MissingBySection {
  denom: string[];
  ssdoh: string[];
  pmhc: string[];
  ipv: string[];
  other: string[];
  total: number;
}

function bucketMissing(missing: string[]): MissingBySection {
  const out: MissingBySection = { denom: [], ssdoh: [], pmhc: [], ipv: [], other: [], total: missing.length };
  for (const f of missing) {
    if (f.startsWith('denom')) out.denom.push(f);
    else if (f.startsWith('ssdoh')) out.ssdoh.push(f);
    else if (f.startsWith('pmhc')) out.pmhc.push(f);
    else if (f.startsWith('ipv')) out.ipv.push(f);
    else out.other.push(f);
  }
  return out;
}

export interface CompletenessResult {
  complete: boolean;
  pct: number;
  missing: MissingBySection;
  ipvScreened: boolean;
}

export function checkCompleteness(row: RedcapRow): CompletenessResult {
  const ipvScreened = String(row[F_IPV_GATE] ?? '').trim() === '1';
  const required = requiredFieldsFor(row);
  const missing = required.filter((f) => !isFieldFilled(row[f]));
  const filled = required.length - missing.length;
  const pct = required.length > 0 ? Math.round((filled / required.length) * 1000) / 10 : 0;
  return { complete: missing.length === 0, pct, missing: bucketMissing(missing), ipvScreened };
}

/** Days between two ISO dates (a - b), whole days. */
function dayDiff(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}

export interface TimelinessResult {
  onTime: boolean | null;
  daysFromDeadline: number | null; // negative = early, positive = late
}

export function checkTimeliness(dateIso: string | null | undefined, quarterKey: string): TimelinessResult {
  const meta = DEADLINES[quarterKey];
  if (!meta || !isFieldFilled(dateIso)) return { onTime: null, daysFromDeadline: null };
  const delta = dayDiff(String(dateIso).trim(), meta.deadline);
  return { onTime: delta <= 0, daysFromDeadline: delta };
}

/** A REDCap submission-date field is usable only when it's a real ISO date.
 *  Corrupt entries (junk typed into the field) must not be treated as a date. */
export function isValidDate(value: unknown): boolean {
  if (!isFieldFilled(value)) return false;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Quarter assignment from a submission date: the most recent quarter whose
 * period ended on/before the date (mirrors determine_quarter in the source).
 * Returned in our "YYYY-Qn" key format. Used as a cross-check against the event.
 */
export function determineQuarter(dateIso: string | null | undefined): string | null {
  if (!isFieldFilled(dateIso)) return null;
  const date = String(dateIso).trim();
  let best: QuarterMeta | null = null;
  for (const meta of Object.values(DEADLINES)) {
    if (date >= meta.periodEnd) {
      if (!best || meta.periodEnd > best.periodEnd) best = meta;
    }
  }
  return best?.key ?? null;
}

// =====================================================================
// Grid: collapse raw rows → one cell per (DAG, quarter)
// =====================================================================

export interface SparkCell {
  dagCode: string;
  quarter: string; // "2026-Q1"
  submitted: boolean;
  complete: boolean;
  pctComplete: number;
  missing: MissingBySection;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  /** True when the date field held a value but it wasn't a valid date. */
  invalidDate: boolean;
  ipvScreened: boolean;
  primaryRecordId: string | null;
  /** Distinct record_ids that carried data for this (DAG, quarter). */
  dataRecordIds: string[];
  /** True when more than one record competed — a data-quality flag. */
  duplicateRecords: boolean;
}

/**
 * Choose the row that represents the official submission for a (DAG, quarter):
 *   1. Prefer rows that carry an @TODAY submission date; among those, the latest.
 *   2. Otherwise (no dated row — e.g. pre-@TODAY back-data) fall back to the most
 *      complete row, breaking ties on the highest denominator total.
 */
function pickPrimaryRow(dataRows: RedcapRow[]): RedcapRow {
  const dated = dataRows.filter((r) => isFieldFilled(r[F_DATE]));
  if (dated.length > 0) {
    return dated.reduce((best, r) =>
      String(r[F_DATE]).trim() > String(best[F_DATE]).trim() ? r : best,
    );
  }
  return dataRows.reduce((best, r) => {
    const rc = filledRequiredCount(r);
    const bc = filledRequiredCount(best);
    if (rc !== bc) return rc > bc ? r : best;
    const rd = Number(r['denom_total'] ?? 0) || 0;
    const bd = Number(best['denom_total'] ?? 0) || 0;
    return rd > bd ? r : best;
  });
}

export interface BuildGridOptions {
  /** DAG codes to ignore entirely (e.g. REDCap's "test" group). */
  ignoreDags?: string[];
}

/**
 * Build the (DAG, quarter) grid from a raw REDCap flat export. Rows whose event
 * isn't a quarterly data event are dropped. Returns a Map keyed by
 * `${dagCode}::${quarter}`.
 */
export function buildSparkGrid(rows: RedcapRow[], opts: BuildGridOptions = {}): Map<string, SparkCell> {
  const ignore = new Set(opts.ignoreDags ?? ['test']);
  // Group all data-bearing rows by (dag, quarter).
  const groups = new Map<string, RedcapRow[]>();
  for (const row of rows) {
    const dag = String(row[F_DAG] ?? '').trim();
    if (!dag || ignore.has(dag)) continue;
    const quarter = eventToQuarter(row[F_EVENT]);
    if (!quarter) continue;
    if (!rowHasData(row)) continue;
    const key = `${dag}::${quarter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const out = new Map<string, SparkCell>();
  for (const [key, dataRows] of groups) {
    const [dagCode, quarter] = key.split('::') as [string, string];
    const primary = pickPrimaryRow(dataRows);
    const completeness = checkCompleteness(primary);
    const rawDate = isFieldFilled(primary[F_DATE]) ? String(primary[F_DATE]).trim() : null;
    // Only treat a valid date as the submission date; corrupt junk → null (N/A)
    // rather than a bogus "late" (or a value that crashes the date-column write).
    const submissionDate = rawDate && isValidDate(rawDate) ? rawDate : null;
    const invalidDate = rawDate !== null && submissionDate === null;
    const timeliness = checkTimeliness(submissionDate, quarter);
    const recordIds = Array.from(
      new Set(dataRows.map((r) => String(r[F_RECORD_ID] ?? '').trim()).filter(Boolean)),
    );
    out.set(key, {
      dagCode,
      quarter,
      submitted: true,
      complete: completeness.complete,
      pctComplete: completeness.pct,
      missing: completeness.missing,
      onTime: timeliness.onTime,
      daysFromDeadline: timeliness.daysFromDeadline,
      submissionDate,
      invalidDate,
      ipvScreened: completeness.ipvScreened,
      primaryRecordId: String(primary[F_RECORD_ID] ?? '').trim() || null,
      dataRecordIds: recordIds,
      duplicateRecords: recordIds.length > 1,
    });
  }
  return out;
}
