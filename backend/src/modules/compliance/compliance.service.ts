/**
 * Compliance engine.
 *
 * Evaluates a single ProgramYear (one year of one enrollment) against its required
 * thresholds. Pure function over input data — the DB layer is a thin adapter built
 * on top of this in compliance.repository.ts.
 *
 * The four legal engagement requirements implemented here:
 *   1. Annual enrollment      — enrollment exists, status = enrolled
 *   2. Meeting attendance     — count of attended in-scope meetings ≥ required
 *   3. QI advising            — count of completed advising tasks ≥ required
 *   4. Data submission        — count of completed data tasks ≥ data_submissions_min
 *      (SPARK's "≥3 of 4 quarters" is expressed as data_submissions_min = 3.)
 *
 * Plus, for every initiative and track:
 *   5. Hospital Readiness Assessment — count of completed HRA tasks ≥ required.
 *      HRAs are required bi-annually (requiredAssessments = 2) across all
 *      initiatives and both tracks. The two HRAs are normally due Q1 + Q4; a
 *      per-program-year override can shift them (e.g., SPARK 2026 is Q2 + Q4).
 *      Scheduling is handled upstream — the engine only checks the count.
 *
 * Annual-forum credit propagation: any in-period MeetingAttendance row counts toward
 * the meeting requirement of *any* of that hospital's active enrollments. Callers
 * provide a pre-filtered list of in-scope attended meetings.
 */

export type RequirementStatus = 'on_track' | 'at_risk' | 'met' | 'not_met';

export interface ProgramYearThresholds {
  /** From program_years.required_meetings */
  requiredMeetings: number;
  /** From program_years.required_advising */
  requiredAdvising: number;
  /** From program_years.required_data_periods (total possible periods, e.g. 12 or 4). */
  requiredDataPeriods: number;
  /** Minimum required to be in compliance. Equals requiredDataPeriods normally; for SPARK = 3. */
  dataSubmissionsMin: number;
  /** From program_years.required_assessments (2 for every initiative and track; HRAs are bi-annual) */
  requiredAssessments: number;
}

export interface ProgramYearProgress {
  /** Number of distinct meetings attended in-scope for this program year. */
  meetingsAttended: number;
  /** Count of qi_advising TaskInstances with status complete. */
  advisingCompleted: number;
  /** Count of data_submission TaskInstances with status complete. */
  dataSubmissionsCompleted: number;
  /** Count of readiness_assessment TaskInstances with status complete. */
  assessmentsCompleted: number;
  /** Status of the enrollment row. */
  enrollmentStatus: 'enrolled' | 'withdrawn' | 'completed' | 'eligible_to_enroll';
}

export interface EvaluationContext {
  /** Calendar year of the program_year row (e.g., 2026). */
  programYear: number;
  /** Today (or as-of date) for pace calculations. */
  asOf: Date;
}

export interface RequirementResult {
  status: RequirementStatus;
  current: number;
  required: number;
  /** Required pace at this point in the year for on_track. */
  expected: number;
  reason?: string;
}

export interface ProgramYearCompliance {
  enrollment: RequirementResult;
  meetings: RequirementResult;
  advising: RequirementResult;
  dataSubmissions: RequirementResult;
  assessments?: RequirementResult;
  /** Overall: 'met' if all met; 'not_met' if any not_met past year-end; else worst of on_track/at_risk. */
  overall: RequirementStatus;
}

/**
 * Returns the fraction of the program year elapsed as of `asOf`, clamped to [0, 1].
 * Program year is treated as Jan 1 → Dec 31. For TTT cross-year cohorts the caller
 * passes the specific calendar year (each program year is evaluated independently).
 */
export function yearProgressFraction(programYear: number, asOf: Date): number {
  const start = Date.UTC(programYear, 0, 1);
  const end = Date.UTC(programYear + 1, 0, 1);
  const now = asOf.getTime();
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}

function evaluateThreshold(
  current: number,
  required: number,
  yearFraction: number,
  yearEnded: boolean,
  label: string,
): RequirementResult {
  // Annual requirements are judged retrospectively. A hospital can be slow in
  // Q1/Q2 and still meet the requirement by year end — we don't pre-emptively
  // shame anyone. Mid-year status reflects activity, not judgment.
  //
  //   met        — current >= required (the threshold is satisfied)
  //   not_met    — year is over and threshold wasn't met
  //   on_track   — year is in progress; recovery is still mathematically plausible
  //   at_risk    — year is in progress, but more than half over AND completion
  //                is less than 30% of the requirement (catastrophically behind)
  const expected = Math.max(0, Math.ceil(required * yearFraction));
  if (current >= required) {
    return { status: 'met', current, required, expected };
  }
  if (yearEnded) {
    return {
      status: 'not_met',
      current,
      required,
      expected: required,
      reason: `Year ended with ${current} of ${required} ${label} complete.`,
    };
  }
  // Only flag at_risk when the gap is severe and time is running out.
  // Before mid-year, never flag — the hospital has plenty of runway.
  if (yearFraction >= 0.5 && current < required * 0.3) {
    return {
      status: 'at_risk',
      current,
      required,
      expected,
      reason: `Significantly behind: ${current} of ${required} ${label} with the year over half elapsed.`,
    };
  }
  return { status: 'on_track', current, required, expected };
}

function worst(...statuses: RequirementStatus[]): RequirementStatus {
  // not_met > at_risk > on_track > met
  const order: Record<RequirementStatus, number> = {
    met: 0,
    on_track: 1,
    at_risk: 2,
    not_met: 3,
  };
  let w: RequirementStatus = 'met';
  for (const s of statuses) {
    if (order[s] > order[w]) w = s;
  }
  return w;
}

export function evaluateProgramYear(
  thresholds: ProgramYearThresholds,
  progress: ProgramYearProgress,
  ctx: EvaluationContext,
): ProgramYearCompliance {
  const yearFraction = yearProgressFraction(ctx.programYear, ctx.asOf);
  const yearEnded = yearFraction >= 1;

  // Whether this program year hasn't started yet (e.g., evaluating 2027 while
  // we're still in 2026). Future years should never surface as at-risk — the
  // hospital may not be re-enrolled until late in the prior year, and we don't
  // want to alarm staff about tracking that isn't active yet.
  const yearNotStarted = ctx.asOf.getUTCFullYear() < ctx.programYear;

  const enrollment: RequirementResult = (() => {
    if (progress.enrollmentStatus === 'enrolled' || progress.enrollmentStatus === 'completed') {
      return { status: 'met', current: 1, required: 1, expected: 1 };
    }
    if (yearNotStarted) {
      // Future year; re-enrollment hasn't happened yet. Show as on_track until
      // the new program year begins (then standard at-risk logic resumes).
      return { status: 'on_track', current: 0, required: 1, expected: 1 };
    }
    return {
      status: yearEnded ? 'not_met' : 'at_risk',
      current: 0,
      required: 1,
      expected: 1,
      reason: `Enrollment status is "${progress.enrollmentStatus}".`,
    };
  })();

  const meetings = evaluateThreshold(
    progress.meetingsAttended,
    thresholds.requiredMeetings,
    yearFraction,
    yearEnded,
    'meetings',
  );

  const advising = evaluateThreshold(
    progress.advisingCompleted,
    thresholds.requiredAdvising,
    yearFraction,
    yearEnded,
    'advising sessions',
  );

  // Data submissions use the configurable minimum, not the total possible periods.
  const dataSubmissions = evaluateThreshold(
    progress.dataSubmissionsCompleted,
    thresholds.dataSubmissionsMin,
    yearFraction,
    yearEnded,
    'data submissions',
  );

  let assessments: RequirementResult | undefined;
  if (thresholds.requiredAssessments > 0) {
    assessments = evaluateThreshold(
      progress.assessmentsCompleted,
      thresholds.requiredAssessments,
      yearFraction,
      yearEnded,
      'readiness assessments',
    );
  }

  const overall = worst(
    enrollment.status,
    meetings.status,
    advising.status,
    dataSubmissions.status,
    ...(assessments ? [assessments.status] : []),
  );

  return { enrollment, meetings, advising, dataSubmissions, assessments, overall };
}
