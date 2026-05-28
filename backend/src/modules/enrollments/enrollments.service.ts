/**
 * Enrollments service.
 *
 * Creates an Enrollment for (hospital, cohort) and:
 *  1. Generates a ProgramYear row for every calendar year covered by the cohort
 *     (1 row for 1-year cohorts; 2 rows for TTT's 2-year cohort) — snapshotting
 *     the required-counts from initiative_track_config so historical years are
 *     stable against future config changes.
 *  2. Generates a TaskInstance for every TaskTemplate (initiative × track), once
 *     per ProgramYear. The instance's `period` and due date are computed from
 *     the template's period semantics (annual / quarterly / monthly).
 *
 * Importantly, the enrollment starts in `eligible_to_enroll` status. It only
 * flips to `enrolled` once the Annual Enrollment Form task instance for that
 * program year is marked complete (see tasks.service when implemented).
 */
import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import {
  computeDueDate,
  computePeriodString,
  type TemplatePeriod,
} from '@/utils/period.js';
import { hraScheduleOverrideFor, scheduleHraInstances } from '@/modules/compliance/hra.js';

export interface CreateEnrollmentInput {
  hospitalId: string;
  cohortId: string;
  enrolledOn?: string; // ISO date; defaults to today
  status?: 'eligible_to_enroll' | 'enrolled';
}

export interface CreateEnrollmentResult {
  enrollmentId: string;
  programYearIds: string[];
  taskInstanceCount: number;
}

export async function createEnrollment(input: CreateEnrollmentInput): Promise<CreateEnrollmentResult> {
  // Verify hospital + cohort exist
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, input.hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found');

  const cohort = await db.query.cohorts.findFirst({
    where: eq(schema.cohorts.id, input.cohortId),
  });
  if (!cohort) throw new HttpError(404, 'Cohort not found');

  // Prevent duplicate enrollments for the same (hospital, cohort)
  const existing = await db.query.enrollments.findFirst({
    where: and(
      eq(schema.enrollments.hospitalId, input.hospitalId),
      eq(schema.enrollments.cohortId, input.cohortId),
    ),
  });
  if (existing) {
    throw new HttpError(409, 'Hospital is already enrolled in this cohort');
  }

  // Look up the initial stage (lowest sequence) for this initiative + track
  const stages = await db
    .select()
    .from(schema.stages)
    .where(
      and(
        eq(schema.stages.initiativeId, cohort.initiativeId),
        eq(schema.stages.track, cohort.track),
      ),
    )
    .orderBy(schema.stages.sequence);
  if (stages.length === 0) {
    throw new HttpError(500, 'No stages configured for this initiative/track');
  }
  const enrollmentStage = stages[0]!;

  // Look up the threshold config (snapshot source)
  const config = await db.query.initiativeTrackConfig.findFirst({
    where: and(
      eq(schema.initiativeTrackConfig.initiativeId, cohort.initiativeId),
      eq(schema.initiativeTrackConfig.track, cohort.track),
    ),
  });
  if (!config) {
    throw new HttpError(500, 'No threshold configuration for this initiative/track');
  }

  // Initiative code drives the per-year HRA schedule (e.g., SPARK 2026 → Q3+Q4).
  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.id, cohort.initiativeId),
  });
  if (!initiative) {
    throw new HttpError(500, 'Cohort references missing initiative');
  }

  // Determine the years covered by this cohort
  const startYear = new Date(cohort.startDate).getUTCFullYear();
  const endYear = new Date(cohort.endDate).getUTCFullYear();
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);

  // Load task templates for this initiative + track
  const templates = await db
    .select()
    .from(schema.taskTemplates)
    .where(
      and(
        eq(schema.taskTemplates.initiativeId, cohort.initiativeId),
        eq(schema.taskTemplates.track, cohort.track),
      ),
    );

  const enrollmentId = uuid();
  const enrolledOn = input.enrolledOn ?? new Date().toISOString().slice(0, 10);
  const programYearIds: string[] = [];
  let taskInstanceCount = 0;

  await db.transaction(async (tx) => {
    await tx.insert(schema.enrollments).values({
      id: enrollmentId,
      hospitalId: input.hospitalId,
      cohortId: input.cohortId,
      currentStageId: enrollmentStage.id,
      status: input.status ?? 'eligible_to_enroll',
      enrolledOn,
    });

    for (const year of years) {
      const programYearId = uuid();
      const hraSchedule = hraScheduleOverrideFor(initiative.code, year);
      await tx.insert(schema.programYears).values({
        id: programYearId,
        enrollmentId,
        year,
        requiredMeetings: config.requiredMeetings,
        requiredAdvising: config.requiredAdvising,
        requiredDataPeriods: config.requiredDataPeriods,
        dataSubmissionsMin: config.dataSubmissionsMin,
        requiredAssessments: config.requiredAssessments,
        hraSchedule,
      });
      programYearIds.push(programYearId);

      // HRA due dates come from the program year's schedule (default Q1+Q4, or an
      // override like SPARK 2026's Q3+Q4) — not the template's own period label.
      const hraTemplates = templates.filter((t) => t.taskType === 'readiness_assessment');
      const hraByTemplate = new Map(
        scheduleHraInstances(hraTemplates, year, hraSchedule).map((s) => [s.templateId, s]),
      );

      // Generate task instances
      for (const template of templates) {
        let period: string;
        let dueOn: string;
        try {
          if (template.taskType === 'readiness_assessment') {
            const scheduled = hraByTemplate.get(template.id);
            if (!scheduled) throw new Error('HRA template missing from computed schedule');
            period = scheduled.period;
            dueOn = scheduled.dueOn;
          } else {
            period = computePeriodString(
              template.period as TemplatePeriod,
              template.periodLabel,
              year,
            );
            dueOn = computeDueDate(template.period as TemplatePeriod, template.periodLabel, year);
          }
        } catch (err) {
          // Skip malformed template rows but log them; do not fail the whole enrollment
          // eslint-disable-next-line no-console
          console.warn(
            `[enrollments] Skipping task template ${template.id} (${template.name}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        await tx.insert(schema.taskInstances).values({
          id: uuid(),
          enrollmentId,
          programYearId,
          taskTemplateId: template.id,
          period,
          dueOn,
          status: 'not_started',
        });
        taskInstanceCount += 1;
      }
    }
  });

  return { enrollmentId, programYearIds, taskInstanceCount };
}

export async function getEnrollment(id: string) {
  const enrollment = await db.query.enrollments.findFirst({
    where: eq(schema.enrollments.id, id),
  });
  if (!enrollment) throw new HttpError(404, 'Enrollment not found');
  return enrollment;
}

/**
 * Finds the active-cohort row for a given initiative + program year. Useful when
 * approving an Interest Form: caller knows the initiative but not the cohort id.
 */
export async function findActiveCohortForInitiativeYear(
  initiativeId: string,
  year: number,
): Promise<typeof schema.cohorts.$inferSelect | null> {
  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(and(eq(schema.cohorts.initiativeId, initiativeId), eq(schema.cohorts.track, 'active')))
    .orderBy(schema.cohorts.startDate);
  for (const c of cohorts) {
    const start = new Date(c.startDate).getUTCFullYear();
    const end = new Date(c.endDate).getUTCFullYear();
    if (year >= start && year <= end) return c;
  }
  return null;
}
