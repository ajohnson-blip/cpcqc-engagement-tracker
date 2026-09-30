/**
 * A parameterised view of the engagement data, for the staff assistant.
 *
 * The grant-report path (engagement-metrics.ts) answers one fixed question for
 * a whole program year. Staff also ask narrower ones — a single metric, a
 * single quarter, ranked by month — so this adds period filtering and grouping
 * while reusing that module's arithmetic. It must stay arithmetically identical:
 * if the assistant and the grant report disagree about SOAR's data submission
 * rate, both numbers become unusable.
 *
 * Pure: period maths, shapes and caveat rules. The query lives in
 * metrics-query.service.ts (the `@/` alias does not resolve under vitest, so
 * anything reaching `@/db` cannot be imported from a test).
 *
 * The caveats are the point of this module. The underlying data has two traps
 * that produce confident, wrong answers:
 *
 *  1. Outcome recording began part-way through 2026. Earlier completions have
 *     a NULL outcome, which counts as engaged and can never count as late or
 *     not-submitted. Those periods therefore score at or near 100% and are not
 *     comparable with later ones — which is fatal for "which month was worst".
 *  2. An initiative can hold cohorts on different cadences (SOAR runs a
 *     monthly Active cohort and a quarterly Sustainability cohort). A quarter
 *     that exists for one and not the other silently drops hospitals.
 *
 * Neither is visible in a bare percentage, so every result carries the caveats
 * that apply to it and the assistant is required to repeat them.
 */
import { pct, ENGAGEMENT_METRICS, type EngagementMetricKey } from '../reports/engagement-metrics.js';

export type Unit = 'task' | 'hospital';
export type GroupBy = 'none' | 'initiative' | 'period' | 'hospital' | 'cohort';

/** What the caller asked for, after validation. */
export interface MetricsQuery {
  programYear: number;
  /** Omit for all five metrics. */
  metric?: EngagementMetricKey;
  /** Initiative codes; omit for all. */
  initiatives?: string[];
  period?: PeriodSpec;
  groupBy?: GroupBy;
  /** Hospital tag, e.g. "Scholarship recipient". */
  cohortTag?: string;
  /**
   * 'task' — share of asked-for activity that happened (the grant-report unit).
   * 'hospital' — share of hospitals that did it at least once. "What percent of
   * hospitals attended a 1:1" is the hospital unit; they differ whenever a
   * hospital has more than one task in the window.
   */
  unit?: Unit;
}

export type PeriodSpec =
  | { kind: 'year' }
  | { kind: 'quarter'; quarter: 1 | 2 | 3 | 4 }
  | { kind: 'month'; month: number }
  | { kind: 'months'; from: number; to: number };

export interface CaveatCode {
  code:
    | 'outcome_backfill'
    | 'provisional'
    | 'mixed_cadence'
    | 'partial_coverage'
    | 'small_denominator'
    | 'no_data'
    | 'unit_is_task';
  severity: 'warning' | 'info';
  message: string;
}

/** One row of the answer. */
export interface MetricsGroup {
  /** Group key — initiative code, period label, hospital name, cohort label, or null. */
  group: string | null;
  metric: EngagementMetricKey;
  metricLabel: string;
  expected: number;
  engaged: number;
  late: number;
  timely: number;
  /** timely / expected, 1dp. Null when nothing was expected. */
  rate: number | null;
  rateInclLate: number | null;
  /** Distinct hospitals contributing to this row. */
  hospitals: number;
  /** Completions with no recorded outcome — see caveat 1. */
  completeNoOutcome: number;
  /** Tasks in this row not yet finalized, so still liable to change. */
  unfinalized: number;
  caveats: CaveatCode[];
}

export interface MetricsAnswer {
  query: MetricsQuery;
  asOf: string;
  unit: Unit;
  groups: MetricsGroup[];
  /** Caveats that apply to the answer as a whole. */
  caveats: CaveatCode[];
  /** Periods actually matched, so the caller can see what "Q3" meant here. */
  periodsMatched: string[];
  /** Cohorts in scope and their cadence, for the mixed-cadence caveat. */
  cohortsInScope: Array<{ label: string; cadence: string; initiativeCode: string }>;
  /**
   * Present only when grouping by period: the rows already ordered by rate.
   *
   * Ranking is done here rather than left to the caller so that periods with
   * no rate are excluded rather than sorted as zero — the difference between
   * "September was our worst month" and "September has not happened yet".
   */
  ranked?: { highest: MetricsGroup[]; lowest: MetricsGroup[] };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The concrete period labels a spec matches.
 *
 * Periods are stored as "2026-03", "2026-Q1" or "2026-annual". A quarter has
 * to match both its own label and its three months, because which one a task
 * carries depends on its cohort's cadence, not on the question being asked.
 *
 * A month deliberately does NOT match the quarter containing it: a quarterly
 * task is not evidence about July, and folding it in would invent detail the
 * data does not have. Callers get a `partial_coverage` caveat instead.
 *
 * "2026-annual" is matched only by a whole-year query. Enrollment is an annual
 * task, so asking for enrollment in Q3 is a question with no answer rather
 * than a zero.
 */
export function expandPeriod(year: number, spec: PeriodSpec | undefined): string[] {
  if (!spec || spec.kind === 'year') {
    return [
      `${year}-annual`,
      ...[1, 2, 3, 4].map((q) => `${year}-Q${q}`),
      ...Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`),
    ];
  }
  if (spec.kind === 'quarter') {
    const first = (spec.quarter - 1) * 3 + 1;
    return [
      `${year}-Q${spec.quarter}`,
      `${year}-${pad2(first)}`,
      `${year}-${pad2(first + 1)}`,
      `${year}-${pad2(first + 2)}`,
    ];
  }
  if (spec.kind === 'month') return [`${year}-${pad2(spec.month)}`];
  const out: string[] = [];
  for (let m = spec.from; m <= spec.to; m += 1) out.push(`${year}-${pad2(m)}`);
  return out;
}

/** Human form of a spec, for the assistant to quote back. */
export function describePeriod(year: number, spec: PeriodSpec | undefined): string {
  if (!spec || spec.kind === 'year') return `${year}`;
  if (spec.kind === 'quarter') return `Q${spec.quarter} ${year}`;
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (spec.kind === 'month') return `${MONTHS[spec.month - 1]} ${year}`;
  return `${MONTHS[spec.from - 1]}–${MONTHS[spec.to - 1]} ${year}`;
}

export const METRIC_BY_KEY = new Map(ENGAGEMENT_METRICS.map((m) => [m.key, m]));

export function taskTypeFor(metric: EngagementMetricKey): string {
  const m = METRIC_BY_KEY.get(metric);
  if (!m) throw new Error(`unknown metric ${metric}`);
  return m.taskType;
}

/** Raw per-group counts as the SQL returns them. */
export interface RawGroup {
  group: string | null;
  taskType: string;
  expected: number;
  engaged: number;
  late: number;
  completeNoOutcome: number;
  unfinalized: number;
  hospitals: number;
}

/**
 * Caveats for a single row.
 *
 * `outcome_backfill` fires on any completion with no recorded outcome. Such a
 * row counts as engaged and cannot count as late, so its rate is an upper
 * bound, not a measurement — the distinction that makes early-2026 months look
 * perfect next to later ones.
 */
export function caveatsForGroup(g: RawGroup, unit: Unit): CaveatCode[] {
  const out: CaveatCode[] = [];
  if (g.completeNoOutcome > 0) {
    out.push({
      code: 'outcome_backfill',
      severity: 'warning',
      message:
        `${g.completeNoOutcome} of ${g.engaged} completions here have no recorded outcome, ` +
        'so they cannot be counted late or not-submitted. This rate is an upper bound and ' +
        'is not comparable with periods where outcomes were recorded.',
    });
  }
  if (g.unfinalized > 0) {
    out.push({
      code: 'provisional',
      severity: 'warning',
      message:
        `${g.unfinalized} task(s) here are not finalized, so a later REDCap sync can still ` +
        'change this figure. Treat it as provisional.',
    });
  }
  if (g.expected > 0 && g.expected < 10) {
    out.push({
      code: 'small_denominator',
      severity: 'info',
      message: `Only ${g.expected} task(s) expected — one hospital moves the rate sharply.`,
    });
  }
  if (g.expected === 0) {
    out.push({
      code: 'no_data',
      severity: 'warning',
      message: 'Nothing was expected in this scope yet, so there is no rate to report.',
    });
  }
  if (unit === 'task') {
    out.push({
      code: 'unit_is_task',
      severity: 'info',
      message:
        'Counted per task, not per hospital: a hospital with several tasks in the window ' +
        'contributes more than one.',
    });
  }
  return out;
}

export function toGroup(g: RawGroup, unit: Unit): MetricsGroup {
  const def = ENGAGEMENT_METRICS.find((m) => m.taskType === g.taskType);
  const timely = g.engaged - g.late;
  return {
    group: g.group,
    metric: (def?.key ?? 'dataSubmission') as EngagementMetricKey,
    metricLabel: def?.label ?? g.taskType,
    expected: g.expected,
    engaged: g.engaged,
    late: g.late,
    timely,
    rate: pct(timely, g.expected),
    rateInclLate: pct(g.engaged, g.expected),
    hospitals: g.hospitals,
    completeNoOutcome: g.completeNoOutcome,
    unfinalized: g.unfinalized,
    caveats: caveatsForGroup(g, unit),
  };
}

/**
 * Caveats about the scope as a whole.
 *
 * `mixed_cadence` is the SOAR trap: an initiative holding both a monthly and a
 * quarterly cohort answers "Q2" from the monthly one only, because the
 * quarterly cohort has no Q2 row. The percentage looks like the initiative and
 * is actually half of it.
 */
export function scopeCaveats(
  cohorts: Array<{ label: string; cadence: string; initiativeCode: string }>,
  cohortsWithData: Set<string>,
  groups: MetricsGroup[],
): CaveatCode[] {
  const out: CaveatCode[] = [];
  const cadences = new Set(cohorts.map((c) => c.cadence));
  if (cadences.size > 1) {
    out.push({
      code: 'mixed_cadence',
      severity: 'warning',
      message:
        'This scope mixes cohorts on different reporting cadences (' +
        cohorts.map((c) => `${c.label}: ${c.cadence}`).join('; ') +
        '). A monthly and a quarterly cohort are not answering the same question.',
    });
  }
  const missing = cohorts.filter((c) => !cohortsWithData.has(c.label));
  if (missing.length > 0) {
    out.push({
      code: 'partial_coverage',
      severity: 'warning',
      message:
        'No tasks exist in this period for: ' +
        missing.map((c) => `${c.label} (${c.cadence})`).join('; ') +
        '. Those hospitals are absent from the figures below, not failing.',
    });
  }
  if (groups.length === 0) {
    out.push({
      code: 'no_data',
      severity: 'warning',
      message: 'Nothing matched this query.',
    });
  }
  return out;
}

/** Highest and lowest groups, ignoring rows with no rate. Used for ranking questions. */
export function rank(groups: MetricsGroup[]): { highest: MetricsGroup[]; lowest: MetricsGroup[] } {
  const rated = groups.filter((g) => g.rate !== null);
  const sorted = [...rated].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
  return { highest: sorted.slice(0, 3), lowest: sorted.slice(-3).reverse() };
}
