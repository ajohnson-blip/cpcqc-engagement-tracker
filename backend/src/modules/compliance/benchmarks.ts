/**
 * Cohort benchmark utilities — pure functions and the DB-backed repository.
 *
 * For each (cohort × program year), we summarize peer progress so hospitals
 * see how they compare without ever seeing other hospitals' names. The shape
 * is intentionally aggregate-only:
 *
 *   - peer median, p25, p75 (positional stats; resistant to outliers)
 *   - count of peers who have met the threshold so far
 *   - my percentile within the cohort (0-100)
 *
 * Privacy: peer hospital identities are never leaked. The only output is
 * counts and quantiles.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';

export interface RequirementBenchmark {
  peerMedian: number;
  peerP25: number;
  peerP75: number;
  peersMet: number;
  peersTotal: number;
  /** This hospital's percentile (0-100) within the cohort for this requirement. */
  myPercentile: number;
}

export interface CohortBenchmark {
  cohortId: string;
  cohortLabel: string;
  peersTotal: number;
  meetings: RequirementBenchmark;
  advising: RequirementBenchmark;
  dataSubmissions: RequirementBenchmark;
  assessments: RequirementBenchmark | null;
}

// ---------- Pure stats ----------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!);
  }
  return sorted[base]!;
}

function percentileOf(value: number, sorted: number[]): number {
  if (sorted.length === 0) return 0;
  // Fraction of peers whose value is < the given value (excluding self if
  // present; we approximate by counting strict-less and adding half of equal).
  let lt = 0;
  let eq = 0;
  for (const v of sorted) {
    if (v < value) lt += 1;
    else if (v === value) eq += 1;
  }
  return Math.round(((lt + eq / 2) / sorted.length) * 100);
}

function summarize(
  myValue: number,
  required: number,
  peerValues: number[],
): RequirementBenchmark {
  const sorted = [...peerValues].sort((a, b) => a - b);
  return {
    peerMedian: Math.round(quantile(sorted, 0.5)),
    peerP25: Math.round(quantile(sorted, 0.25)),
    peerP75: Math.round(quantile(sorted, 0.75)),
    peersMet: peerValues.filter((v) => v >= required).length,
    peersTotal: peerValues.length,
    myPercentile: percentileOf(myValue, sorted),
  };
}

// ---------- DB-backed cohort progress collection ----------

interface PeerProgress {
  enrollmentId: string;
  meetings: number;
  advising: number;
  dataSubmissions: number;
  assessments: number;
}

/**
 * For every enrollment in a cohort × program year, return that enrollment's
 * completed-task counts grouped by task type.
 */
async function collectCohortProgress(
  cohortId: string,
  programYear: number,
): Promise<PeerProgress[]> {
  // All enrollments in this cohort
  const enrollments = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.cohortId, cohortId));
  if (enrollments.length === 0) return [];

  // Their program-year rows for the matching year
  const enrollmentIds = enrollments.map((e) => e.id);
  const programYearRows = await db
    .select()
    .from(schema.programYears)
    .where(eq(schema.programYears.year, programYear));
  const pyByEnrollment = new Map<string, string>();
  for (const py of programYearRows) {
    if (enrollmentIds.includes(py.enrollmentId)) {
      pyByEnrollment.set(py.enrollmentId, py.id);
    }
  }

  // Bulk-count completed task instances grouped by (enrollment, task_type)
  const programYearIds = Array.from(pyByEnrollment.values());
  if (programYearIds.length === 0) return [];

  const completedRows = await db
    .select({
      programYearId: schema.taskInstances.programYearId,
      enrollmentId: schema.taskInstances.enrollmentId,
      taskType: schema.taskTemplates.taskType,
    })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .where(eq(schema.taskInstances.status, 'complete'));

  // Tally per enrollment
  const counts = new Map<string, PeerProgress>();
  for (const e of enrollments) {
    const pyId = pyByEnrollment.get(e.id);
    if (!pyId) continue;
    counts.set(e.id, {
      enrollmentId: e.id,
      meetings: 0,
      advising: 0,
      dataSubmissions: 0,
      assessments: 0,
    });
  }
  for (const row of completedRows) {
    const bucket = counts.get(row.enrollmentId);
    if (!bucket) continue;
    if (pyByEnrollment.get(row.enrollmentId) !== row.programYearId) continue;
    if (row.taskType === 'meeting_attendance') bucket.meetings += 1;
    else if (row.taskType === 'qi_advising') bucket.advising += 1;
    else if (row.taskType === 'data_submission') bucket.dataSubmissions += 1;
    else if (row.taskType === 'readiness_assessment') bucket.assessments += 1;
  }
  return Array.from(counts.values());
}

interface BenchmarkInputs {
  cohortId: string;
  cohortLabel: string;
  programYear: number;
  myEnrollmentId: string;
  /** Snapshot thresholds for the requesting hospital — used to compute "peers met" */
  thresholds: {
    requiredMeetings: number;
    requiredAdvising: number;
    dataSubmissionsMin: number;
    requiredAssessments: number;
  };
}

/**
 * Compute the cohort benchmark for one hospital's enrollment in one program year.
 *
 * Excludes the requesting hospital's own progress from the peer set so the
 * percentile compares them to others, not to themselves.
 */
export async function computeCohortBenchmark(input: BenchmarkInputs): Promise<CohortBenchmark> {
  const all = await collectCohortProgress(input.cohortId, input.programYear);
  const mine = all.find((p) => p.enrollmentId === input.myEnrollmentId);
  const peers = all.filter((p) => p.enrollmentId !== input.myEnrollmentId);

  return {
    cohortId: input.cohortId,
    cohortLabel: input.cohortLabel,
    peersTotal: peers.length,
    meetings: summarize(
      mine?.meetings ?? 0,
      input.thresholds.requiredMeetings,
      peers.map((p) => p.meetings),
    ),
    advising: summarize(
      mine?.advising ?? 0,
      input.thresholds.requiredAdvising,
      peers.map((p) => p.advising),
    ),
    dataSubmissions: summarize(
      mine?.dataSubmissions ?? 0,
      input.thresholds.dataSubmissionsMin,
      peers.map((p) => p.dataSubmissions),
    ),
    assessments:
      input.thresholds.requiredAssessments > 0
        ? summarize(
            mine?.assessments ?? 0,
            input.thresholds.requiredAssessments,
            peers.map((p) => p.assessments),
          )
        : null,
  };
}
