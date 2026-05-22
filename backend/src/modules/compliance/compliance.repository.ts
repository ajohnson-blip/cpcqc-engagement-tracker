/**
 * Compliance repository — the DB adapter on top of the pure compliance engine.
 *
 * Loads a ProgramYear, gathers task-completion counts by task type, looks up the
 * enrollment status, and calls evaluateProgramYear() to produce a structured
 * compliance result. This is what the dashboards consume.
 *
 * Note on cross-initiative annual forum credit: in the current model, attending
 * the annual forum credits one task instance at a time (the hospital or PM marks
 * each enrollment's meeting task complete). Future enhancement: auto-propagate
 * to all of the hospital's active enrollments when one is marked.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import {
  evaluateProgramYear,
  type ProgramYearCompliance,
  type ProgramYearProgress,
  type ProgramYearThresholds,
} from './compliance.service.js';

export interface ComplianceForProgramYear {
  programYearId: string;
  programYear: number;
  enrollmentId: string;
  cohortLabel: string;
  initiativeCode: string;
  track: 'active' | 'sustainability';
  thresholds: ProgramYearThresholds;
  progress: ProgramYearProgress;
  result: ProgramYearCompliance;
}

export async function evaluateProgramYearById(
  programYearId: string,
  asOf: Date = new Date(),
): Promise<ComplianceForProgramYear> {
  const py = await db.query.programYears.findFirst({
    where: eq(schema.programYears.id, programYearId),
  });
  if (!py) throw new HttpError(404, 'Program year not found');

  const enrollment = await db.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, py.enrollmentId),
  });
  if (!enrollment) throw new HttpError(500, 'Program year references missing enrollment');

  const cohort = await db.query.cohorts.findFirst({
    where: eq(schema.cohorts.id, enrollment.cohortId),
  });
  if (!cohort) throw new HttpError(500, 'Enrollment references missing cohort');

  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.id, cohort.initiativeId),
  });
  if (!initiative) throw new HttpError(500, 'Cohort references missing initiative');

  // Count completed task instances by task type, scoped to this program year.
  // Excludes 'late' and 'missed' outcomes: those are recorded for the audit
  // trail but do not satisfy the compliance threshold. NULL outcome (legacy
  // imports + pre-outcome-field rows) is still counted, preserving back-compat.
  const completedCountsRaw = await db
    .select({
      taskType: schema.taskTemplates.taskType,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .where(
      and(
        eq(schema.taskInstances.programYearId, programYearId),
        eq(schema.taskInstances.status, 'complete'),
        sql`(${schema.taskInstances.outcome} IS NULL OR ${schema.taskInstances.outcome} IN ('on_time', 'attended'))`,
      ),
    )
    .groupBy(schema.taskTemplates.taskType);

  const countsByType = new Map<string, number>();
  for (const row of completedCountsRaw) {
    countsByType.set(row.taskType, row.count);
  }

  const progress: ProgramYearProgress = {
    meetingsAttended: countsByType.get('meeting_attendance') ?? 0,
    advisingCompleted: countsByType.get('qi_advising') ?? 0,
    dataSubmissionsCompleted: countsByType.get('data_submission') ?? 0,
    assessmentsCompleted: countsByType.get('readiness_assessment') ?? 0,
    enrollmentStatus: enrollment.status,
  };

  const thresholds: ProgramYearThresholds = {
    requiredMeetings: py.requiredMeetings,
    requiredAdvising: py.requiredAdvising,
    requiredDataPeriods: py.requiredDataPeriods,
    dataSubmissionsMin: py.dataSubmissionsMin,
    requiredAssessments: py.requiredAssessments,
  };

  const result = evaluateProgramYear(thresholds, progress, {
    programYear: py.year,
    asOf,
  });

  return {
    programYearId: py.id,
    programYear: py.year,
    enrollmentId: enrollment.id,
    cohortLabel: cohort.label,
    initiativeCode: initiative.code,
    track: cohort.track,
    thresholds,
    progress,
    result,
  };
}

/**
 * Evaluates compliance for every program year of an enrollment, returning them
 * sorted oldest-first. Useful for the hospital and staff hospital-detail views.
 */
export async function evaluateEnrollment(
  enrollmentId: string,
  asOf: Date = new Date(),
): Promise<ComplianceForProgramYear[]> {
  const programYears = await db
    .select({ id: schema.programYears.id, year: schema.programYears.year })
    .from(schema.programYears)
    .where(eq(schema.programYears.enrollmentId, enrollmentId))
    .orderBy(schema.programYears.year);
  const results: ComplianceForProgramYear[] = [];
  for (const py of programYears) {
    results.push(await evaluateProgramYearById(py.id, asOf));
  }
  return results;
}

/**
 * Picks the "current" program year for an enrollment by today's calendar year,
 * with sensible fallbacks. Used for dashboard at-a-glance displays.
 */
export function pickCurrentProgramYear(
  results: ComplianceForProgramYear[],
  asOf: Date = new Date(),
): ComplianceForProgramYear | null {
  if (results.length === 0) return null;
  const currentYear = asOf.getUTCFullYear();
  const exact = results.find((r) => r.programYear === currentYear);
  if (exact) return exact;
  // No row for this year — return the most recent past year if any; else the earliest future year.
  const past = results.filter((r) => r.programYear < currentYear);
  if (past.length > 0) return past[past.length - 1]!;
  return results[0]!;
}
