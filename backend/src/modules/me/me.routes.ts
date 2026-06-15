/**
 * Hospital portal endpoints — data for the logged-in hospital user's own dashboard.
 *
 * GET /me/enrollments
 *   Every enrollment for the user's hospital, with current program year, current
 *   stage, and a structured compliance summary (the four-tile traffic-light data
 *   the home page renders).
 *
 * GET /me/tasks
 *   Aggregated task list across all the user's enrollments, sortable by due date
 *   and filterable by status. Powers the hospital's "things to do" view.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { requireAuth, resolveActiveHospitalId } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import {
  evaluateEnrollment,
  pickCurrentProgramYear,
} from '@/modules/compliance/compliance.repository.js';
import { computeCohortBenchmark, type CohortBenchmark } from '@/modules/compliance/benchmarks.js';
import { getTeamsForInitiativeIds } from '@/modules/staff/staff-team.service.js';

const router = Router();

router.get('/enrollments', requireAuth, async (req, res) => {
  if (req.auth!.hospitalIds.length === 0) {
    res.json({ enrollments: [] });
    return;
  }
  // Regional users pass the active hospital from the portal switcher; it must
  // be one they can access. Defaults to their primary.
  const requested = z.string().uuid().optional().parse(req.query.hospitalId);
  const hospitalId = resolveActiveHospitalId(req.auth!, requested);

  const enrollments = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.hospitalId, hospitalId));

  if (enrollments.length === 0) {
    res.json({ enrollments: [] });
    return;
  }

  const cohortIds = enrollments.map((e) => e.cohortId);
  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(inArray(schema.cohorts.id, cohortIds));
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const initiativeIds = Array.from(new Set(cohorts.map((c) => c.initiativeId)));
  const initiatives = await db
    .select()
    .from(schema.initiatives)
    .where(inArray(schema.initiatives.id, initiativeIds));
  const initiativeById = new Map(initiatives.map((i) => [i.id, i]));

  const stageIds = enrollments.map((e) => e.currentStageId).filter((s): s is string => !!s);
  const stages = stageIds.length
    ? await db.select().from(schema.stages).where(inArray(schema.stages.id, stageIds))
    : [];
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // CPCQC team contacts for every initiative this hospital is in.
  const teamByInitiative = await getTeamsForInitiativeIds(initiativeIds);

  const out = await Promise.all(
    enrollments.map(async (e) => {
      const cohort = cohortById.get(e.cohortId);
      const initiative = cohort ? initiativeById.get(cohort.initiativeId) : null;
      const stage = e.currentStageId ? stageById.get(e.currentStageId) : null;
      const compliance = await evaluateEnrollment(e.id);
      const current = pickCurrentProgramYear(compliance);

      // Attach a cohort benchmark for the current program year so the portal
      // can show "vs peers" comparisons. Privacy: aggregate counts only.
      let cohortBenchmark: CohortBenchmark | null = null;
      if (cohort && current) {
        try {
          cohortBenchmark = await computeCohortBenchmark({
            cohortId: cohort.id,
            cohortLabel: cohort.label,
            programYear: current.programYear,
            myEnrollmentId: e.id,
            thresholds: {
              requiredMeetings: current.thresholds.requiredMeetings,
              requiredAdvising: current.thresholds.requiredAdvising,
              dataSubmissionsMin: current.thresholds.dataSubmissionsMin,
              requiredAssessments: current.thresholds.requiredAssessments,
            },
          });
        } catch {
          cohortBenchmark = null;
        }
      }

      return {
        enrollmentId: e.id,
        status: e.status,
        enrolledOn: e.enrolledOn,
        cohort: cohort
          ? { id: cohort.id, label: cohort.label, track: cohort.track, startDate: cohort.startDate, endDate: cohort.endDate }
          : null,
        initiative: initiative
          ? {
              id: initiative.id,
              code: initiative.code,
              name: initiative.name,
              brandColor: initiative.brandColor,
              emoji: initiative.emoji,
            }
          : null,
        currentStage: stage
          ? { id: stage.id, code: stage.code, name: stage.name, sequence: stage.sequence }
          : null,
        currentProgramYear: current,
        allProgramYears: compliance,
        cohortBenchmark,
        team: initiative ? teamByInitiative.get(initiative.id) ?? null : null,
      };
    }),
  );

  res.json({ enrollments: out });
});

// Read-only champion roster for the user's (active) hospital — powers the
// portal Team tab. Hospitals view their own roster; CPCQC owns edits, so
// there's no write path here (corrections flow through Report issue).
router.get('/roster', requireAuth, async (req, res) => {
  if (req.auth!.hospitalIds.length === 0) {
    res.json({ roster: [] });
    return;
  }
  const requested = z.string().uuid().optional().parse(req.query.hospitalId);
  const hospitalId = resolveActiveHospitalId(req.auth!, requested);

  const rows = await db
    .select({
      id: schema.hospitalStaffMembers.id,
      name: schema.hospitalStaffMembers.name,
      role: schema.hospitalStaffMembers.role,
      email: schema.hospitalStaffMembers.email,
      phone: schema.hospitalStaffMembers.phone,
      initiativeCode: schema.initiatives.code,
      initiativeName: schema.initiatives.name,
    })
    .from(schema.hospitalStaffMembers)
    .leftJoin(
      schema.initiatives,
      eq(schema.initiatives.id, schema.hospitalStaffMembers.initiativeId),
    )
    .where(eq(schema.hospitalStaffMembers.hospitalId, hospitalId))
    .orderBy(schema.hospitalStaffMembers.name);

  res.json({
    roster: rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      email: r.email,
      phone: r.phone,
      initiative: r.initiativeCode
        ? { code: r.initiativeCode, name: r.initiativeName }
        : null,
    })),
  });
});

router.get('/tasks', requireAuth, async (req, res) => {
  if (req.auth!.hospitalIds.length === 0) {
    res.json({ tasks: [] });
    return;
  }
  const query = z
    .object({
      status: z.enum(['not_started', 'current_activities', 'complete', 'needs_revision']).optional(),
      programYear: z.coerce.number().int().min(2025).max(2100).optional(),
      hospitalId: z.string().uuid().optional(),
    })
    .parse(req.query);
  const hospitalId = resolveActiveHospitalId(req.auth!, query.hospitalId);

  const enrollmentIds = (
    await db
      .select({ id: schema.enrollments.id })
      .from(schema.enrollments)
      .where(eq(schema.enrollments.hospitalId, hospitalId))
  ).map((r) => r.id);

  if (enrollmentIds.length === 0) {
    res.json({ tasks: [] });
    return;
  }

  const rows = await db
    .select({
      task: schema.taskInstances,
      template: schema.taskTemplates,
      stage: schema.stages,
      programYear: schema.programYears,
      initiative: schema.initiatives,
    })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .innerJoin(schema.stages, eq(schema.stages.id, schema.taskTemplates.stageId))
    .innerJoin(
      schema.programYears,
      eq(schema.programYears.id, schema.taskInstances.programYearId),
    )
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.taskTemplates.initiativeId))
    .where(inArray(schema.taskInstances.enrollmentId, enrollmentIds))
    .orderBy(asc(schema.taskInstances.dueOn));

  // Hide future-year tasks until that year's Enrollment Form is submitted.
  // See the matching filter in tasks.service.ts listTasksForEnrollment for
  // rationale. Builds a (enrollmentId, year) → ef-complete map across all rows.
  const currentYear = new Date().getUTCFullYear();
  const futureEfComplete = new Map<string, boolean>();
  for (const r of rows) {
    if (r.programYear.year <= currentYear) continue;
    if (r.template.taskType !== 'enrollment_form') continue;
    futureEfComplete.set(
      `${r.task.enrollmentId}::${r.programYear.year}`,
      r.task.status === 'complete',
    );
  }
  const visibleRows = rows.filter((r) => {
    if (r.programYear.year <= currentYear) return true;
    if (r.template.taskType === 'enrollment_form') return true;
    return futureEfComplete.get(`${r.task.enrollmentId}::${r.programYear.year}`) === true;
  });

  let tasks = visibleRows.map((r) => ({
    id: r.task.id,
    enrollmentId: r.task.enrollmentId,
    programYear: r.programYear.year,
    initiative: { code: r.initiative.code, name: r.initiative.name },
    stage: { code: r.stage.code, name: r.stage.name },
    template: {
      name: r.template.name,
      taskType: r.template.taskType,
      knowledgeCenterUrl: r.template.knowledgeCenterUrl,
    },
    period: r.task.period,
    dueOn: r.task.dueOn,
    status: r.task.status,
    outcome: r.task.outcome,
    completedOn: r.task.completedOn,
  }));

  if (query.status) tasks = tasks.filter((t) => t.status === query.status);
  if (query.programYear) tasks = tasks.filter((t) => t.programYear === query.programYear);

  res.json({ tasks });
});

// Helper used internally in case future routes need it.
export async function getMyHospitalId(userId: string): Promise<string | null> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  return user.hospitalId ?? null;
}

export default router;
