/**
 * The five engagement metrics CPCQC reports to funders — enrollment, survey
 * completion, coaching participation, meeting participation and data
 * submission — as participation rates.
 *
 * Pure: shapes, arithmetic and the narrative wording. The database query lives
 * in engagement-metrics.service.ts, which keeps this side testable (the `@/`
 * alias does not resolve under vitest, so anything reaching `@/db` cannot be
 * imported from a test).
 *
 * Distinct from the annual report, which answers "is each hospital compliant?"
 * per enrollment. A grant report asks a different question: across everyone,
 * what share of what was asked for actually happened.
 */

export const ENGAGEMENT_METRICS = [
  { key: 'enrollment', label: 'Enrollment', taskType: 'enrollment_form' },
  { key: 'survey', label: 'Survey completion', taskType: 'readiness_assessment' },
  { key: 'coaching', label: 'Coaching participation', taskType: 'qi_advising' },
  { key: 'meetings', label: 'Meeting participation', taskType: 'meeting_attendance' },
  { key: 'dataSubmission', label: 'Data submission', taskType: 'data_submission' },
] as const;

export type EngagementMetricKey = (typeof ENGAGEMENT_METRICS)[number]['key'];

export interface Tally {
  /**
   * Tasks already due or already done.
   *
   * Deadline-only would push rates over 100% whenever a hospital works ahead;
   * done-only would flatter a program that has not been asked for anything yet.
   */
  expected: number;
  /**
   * Completed and not recorded as missed or not submitted.
   *
   * Those two are stored as status=complete with a qualifying outcome — a
   * deliberate record that nothing arrived — so counting status alone reports
   * non-participation as participation. A null outcome does count: outcomes
   * were added after the tracker was in use, and most 2026 completions predate
   * them.
   */
  engaged: number;
  /** Of those, the ones that arrived late — engagement that does not count
   *  toward SB24-175 compliance. */
  late: number;
}

export interface EngagementMetric extends Tally {
  key: EngagementMetricKey;
  label: string;
  /** engaged / expected, to 1dp. Null when nothing is expected yet. */
  rate: number | null;
  /** (engaged - late) / expected — the compliance-strict view. */
  strictRate: number | null;
}

export interface EngagementScope {
  /** null for the all-programs roll-up. */
  initiativeCode: string | null;
  initiativeName: string | null;
  hospitals: number;
  metrics: EngagementMetric[];
}

export interface EngagementSummary {
  programYear: number;
  asOf: string;
  overall: EngagementScope;
  byInitiative: EngagementScope[];
}

export const EMPTY_TALLY: Tally = { expected: 0, engaged: 0, late: 0 };

export function pct(n: number, d: number): number | null {
  if (d === 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

export function toMetrics(get: (taskType: string) => Tally): EngagementMetric[] {
  return ENGAGEMENT_METRICS.map((m) => {
    const t = get(m.taskType);
    return {
      key: m.key,
      label: m.label,
      expected: t.expected,
      engaged: t.engaged,
      late: t.late,
      rate: pct(t.engaged, t.expected),
      strictRate: pct(t.engaged - t.late, t.expected),
    };
  });
}

/** Program codes as CPCQC writes them in prose. */
export function programLabel(code: string): string {
  return code === 'TTT' ? 'Turning the Tide' : code;
}

/**
 * The paragraph itself, in the shape CPCQC has used in past grant reports.
 * Kept here so the wording lives in one place rather than being retyped each
 * reporting cycle.
 */
export function engagementNarrative(summary: EngagementSummary): string {
  const rate = (k: EngagementMetricKey): string => {
    const m = summary.overall.metrics.find((x) => x.key === k);
    return m === undefined || m.rate === null ? 'n/a' : `${m.rate}%`;
  };
  const programs = summary.byInitiative
    .map((i) => i.initiativeCode)
    .filter((c): c is string => !!c)
    .map(programLabel);
  const programList =
    programs.length > 1
      ? `${programs.slice(0, -1).join(', ')}, and ${programs[programs.length - 1]}`
      : (programs[0] ?? 'all programs');

  return (
    `CPCQC is tracking five key hospital engagement metrics—enrollment, survey completion, ` +
    `coaching participation, meeting participation, and data submission—across all programs, ` +
    `with specific attention to SB24-175 compliance. Current overall rates: ` +
    `enrollment ${rate('enrollment')}, survey completion ${rate('survey')}, ` +
    `coaching ${rate('coaching')}, meeting participation ${rate('meetings')}, ` +
    `data submission ${rate('dataSubmission')}. ` +
    `Program-specific tracking is in place for ${programList}.`
  );
}
