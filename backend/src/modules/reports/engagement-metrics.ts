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
  /** Of those, the ones that arrived late. */
  late: number;
}

export interface EngagementMetric extends Tally {
  key: EngagementMetricKey;
  label: string;
  /** engaged minus late: submissions that were timely AND complete. */
  timely: number;
  /**
   * The reported rate — timely / expected, to 1dp. Null when nothing is
   * expected yet.
   *
   * Late is excluded because it fails CPCQC's operational definition of
   * "timely and complete": a submission that arrived after the deadline did
   * not meet the requirement, whatever else is true of it.
   */
  rate: number | null;
  /** Including late arrivals — context only, never the reported figure. */
  rateInclLate: number | null;
}

/**
 * Hospital-level view of the statutory duty.
 *
 * SB24-175 obliges each hospital to engage in at least one QI initiative, so
 * the unit is the hospital, not the enrollment: a hospital in four initiatives
 * discharges the same single duty as one in one. The metrics above answer
 * "what share of asked-for activity happened"; this answers "how many
 * hospitals are meeting the law".
 */
export interface StatutoryCompliance {
  /**
   * Hospitals known to the tracker. Whether that equals every hospital the
   * statute covers is a question about the roster, not about this figure —
   * a hospital absent from the tracker cannot show up as non-compliant here.
   */
  hospitals: number;
  /** Hospitals with at least one active enrollment. */
  engagedInAtLeastOne: number;
  /** Hospitals with no enrollment at all — non-compliant on the face of it. */
  notEngaged: number;
  /** Meeting, or on track to meet, every requirement of ≥1 initiative. */
  compliantInAtLeastOne: number;
  /** Already fully met ≥1 initiative (rare before year end). */
  metInAtLeastOne: number;
  /** Enrolled, but at risk or not met in every initiative — the follow-up list. */
  atRiskInAll: number;
  /** How many initiatives hospitals have taken on. */
  byInitiativeCount: Array<{ initiatives: number; hospitals: number }>;
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
  /** Cohort tag these figures are scoped to; null for the whole collaborative. */
  cohort: string | null;
  overall: EngagementScope;
  byInitiative: EngagementScope[];
  statutory: StatutoryCompliance;
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
      timely: t.engaged - t.late,
      rate: pct(t.engaged - t.late, t.expected),
      rateInclLate: pct(t.engaged, t.expected),
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

  // A cohort report has to say so in its first sentence. The same numbers
  // read as a claim about the whole collaborative otherwise, which is the
  // easiest way for a scoped figure to end up misquoted in a grant.
  const scope = summary.cohort
    ? `for the ${summary.statutory.hospitals} hospitals in the ` +
      `\u201C${summary.cohort}\u201D cohort`
    : 'across all programs';

  return (
    `CPCQC is tracking five key hospital engagement metrics—enrollment, survey completion, ` +
    `coaching participation, meeting participation, and data submission—${scope}, ` +
    `with specific attention to SB24-175 compliance. Current overall rates: ` +
    `enrollment ${rate('enrollment')}, survey completion ${rate('survey')}, ` +
    `coaching ${rate('coaching')}, meeting participation ${rate('meetings')}, ` +
    `data submission ${rate('dataSubmission')}. ` +
    `Program-specific tracking is in place for ${programList}. ` +
    statutorySentence(summary.statutory, summary.cohort)
  );
}

/**
 * The statutory duty in one sentence: SB24-175 requires engagement in at least
 * one initiative, so this counts hospitals rather than enrollments.
 */
export function statutorySentence(s: StatutoryCompliance, cohort?: string | null): string {
  if (s.hospitals === 0) {
    return cohort ? `No hospitals are tagged \u201C${cohort}\u201D.` : 'No hospitals are currently tracked.';
  }
  const noun = cohort ? 'hospitals in this cohort' : 'tracked hospitals';
  const engagedPct = pct(s.engagedInAtLeastOne, s.hospitals);
  const all = s.engagedInAtLeastOne === s.hospitals;
  const lead = all
    ? `All ${s.hospitals} ${noun} (100%) are engaged in at least one initiative, ` +
      `meeting the SB24-175 requirement of participation in a minimum of one.`
    : `${s.engagedInAtLeastOne} of ${s.hospitals} ${noun} ` +
      `(${engagedPct === null ? 'n/a' : `${engagedPct}%`}) are engaged in at least one ` +
      `initiative as SB24-175 requires; ${s.notEngaged} ` +
      `${s.notEngaged === 1 ? 'is' : 'are'} not currently enrolled in any.`;

  const onTrack =
    s.compliantInAtLeastOne === s.engagedInAtLeastOne
      ? ` All are meeting or on track to meet every requirement of at least one initiative.`
      : ` ${s.compliantInAtLeastOne} are meeting or on track to meet every requirement of at ` +
        `least one initiative; ${s.atRiskInAll} ${s.atRiskInAll === 1 ? 'is' : 'are'} at risk ` +
        `across all of their initiatives.`;

  return lead + onTrack;
}
