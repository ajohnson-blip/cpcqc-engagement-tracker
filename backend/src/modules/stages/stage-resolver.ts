/**
 * Compute the *correct* current stage for an enrollment based on the calendar
 * (and whether the year's enrollment form has been submitted).
 *
 * Stage progression is date-driven, NOT task-completion-driven:
 *
 *   - If the enrollment form for the current program year is not complete,
 *     the enrollment stays at the "Enrollment" stage (code "1.").
 *   - Otherwise, the stage corresponds to the calendar quarter:
 *       Q1 (Jan–Mar) → Implementation Q1 / Sustainability Q1
 *       Q2 (Apr–Jun) → Q2
 *       Q3 (Jul–Sep) → Q3
 *       Q4 (Oct–Dec) → Q4
 *
 * Annual requirements (≥9 meetings, etc.) are judged retrospectively at year
 * end. A hospital can miss months of activity mid-year and still meet the
 * requirement by attending more later. Stage tells you *when in the program
 * year* the hospital is — it never penalizes them for being behind.
 *
 * This function is the single source of truth used by:
 *   - tasks.service.ts maybeAdvanceStage (after each task completion)
 *   - scripts/recompute-stages.ts (manual recompute)
 *   - scripts/import-pm-engagement-data.ts (post-import pass)
 */
import { and, eq } from 'drizzle-orm';
import { db, schema, type Database } from '@/db/index.js';
import { quarterOf } from '@/utils/period.js';

export interface StageResolution {
  /** ID of the stage the enrollment should be at right now. */
  stageId: string;
  /** Stage code (e.g., "1.", "2.1", "3.2") — useful for logging. */
  stageCode: string;
  /** Stage name — useful for logging. */
  stageName: string;
  /** Whether the enrollment form for the current program year is complete. */
  enrollmentFormComplete: boolean;
  /** Quarter (1–4) used to pick the stage, or null when staying at Enrollment. */
  quarter: number | null;
}

export async function computeCurrentStageForEnrollment(
  enrollmentId: string,
  asOf: Date = new Date(),
  client: Database = db,
): Promise<StageResolution | null> {
  const enrollment = await client.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, enrollmentId),
  });
  if (!enrollment) return null;

  const cohort = await client.query.cohorts.findFirst({
    where: eq(schema.cohorts.id, enrollment.cohortId),
  });
  if (!cohort) return null;

  // Load all stages for this (initiative, track) once.
  const stages = await client
    .select()
    .from(schema.stages)
    .where(
      and(
        eq(schema.stages.initiativeId, cohort.initiativeId),
        eq(schema.stages.track, cohort.track),
      ),
    );
  const enrollmentStage = stages.find((s) => s.code === '1.');
  if (!enrollmentStage) return null;

  // Figure out the active program year for `asOf`.
  const currentYear = asOf.getUTCFullYear();
  const programYear = await client.query.programYears.findFirst({
    where: and(
      eq(schema.programYears.enrollmentId, enrollmentId),
      eq(schema.programYears.year, currentYear),
    ),
  });

  // If there's no program year for this calendar year, the enrollment isn't
  // active this year — keep it at Enrollment as a sensible default.
  if (!programYear) {
    return {
      stageId: enrollmentStage.id,
      stageCode: enrollmentStage.code,
      stageName: enrollmentStage.name,
      enrollmentFormComplete: false,
      quarter: null,
    };
  }

  // Is the enrollment form for this program year complete?
  const ef = await client
    .select({ ti: schema.taskInstances })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .where(
      and(
        eq(schema.taskInstances.enrollmentId, enrollmentId),
        eq(schema.taskInstances.programYearId, programYear.id),
        eq(schema.taskTemplates.taskType, 'enrollment_form'),
      ),
    )
    .limit(1);
  const enrollmentFormComplete = ef[0]?.ti.status === 'complete';

  if (!enrollmentFormComplete) {
    return {
      stageId: enrollmentStage.id,
      stageCode: enrollmentStage.code,
      stageName: enrollmentStage.name,
      enrollmentFormComplete: false,
      quarter: null,
    };
  }

  // Enrollment form is complete — stage = stage for current quarter
  // (Implementation Q1–Q4 or Sustainability Q1–Q4).
  const quarter = quarterOf(asOf);
  const quarterStage = stages.find((s) => s.quarter === quarter);
  if (!quarterStage) {
    return {
      stageId: enrollmentStage.id,
      stageCode: enrollmentStage.code,
      stageName: enrollmentStage.name,
      enrollmentFormComplete: true,
      quarter,
    };
  }
  return {
    stageId: quarterStage.id,
    stageCode: quarterStage.code,
    stageName: quarterStage.name,
    enrollmentFormComplete: true,
    quarter,
  };
}
