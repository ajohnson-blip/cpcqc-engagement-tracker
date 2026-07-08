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
import type { ProgramYearCompliance, RequirementStatus } from '@/modules/compliance/compliance.service.js';
import { computeCohortBenchmark, type CohortBenchmark } from '@/modules/compliance/benchmarks.js';
import { getTeamsForInitiativeIds } from '@/modules/staff/staff-team.service.js';
import { dedupeWithdrawnDuplicates, selectOverviewRollup } from '@/modules/staff/staff.rollup.js';

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

/**
 * GET /me/rollup — system-lead rollup across ALL the user's linked hospitals.
 *
 * For a health-system QI lead with multi-hospital access: one compliance cell
 * per (hospital, initiative) for the current program year, plus a worst-first
 * "needs attention" list. Read-only and strictly scoped to req.auth.hospitalIds
 * — never returns data for a hospital the user isn't linked to. Reuses the exact
 * roster-selection + compliance logic behind /staff/overview.
 */
const REQ_KEYS: ReadonlyArray<{
  key: 'enrollment' | 'meetings' | 'advising' | 'dataSubmissions' | 'assessments';
  label: string;
}> = [
  { key: 'enrollment', label: 'Enrollment' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'advising', label: 'QI advising' },
  { key: 'dataSubmissions', label: 'Data submissions' },
  { key: 'assessments', label: 'Assessments' },
];

const ROLLUP_STATUS_ORDER: Record<RequirementStatus, number> = {
  not_met: 0,
  at_risk: 1,
  on_track: 2,
  met: 3,
};

function failingRequirements(result: ProgramYearCompliance) {
  const fails: Array<{ requirement: string; status: RequirementStatus; current: number; required: number }> = [];
  for (const { key, label } of REQ_KEYS) {
    const rr = result[key];
    if (rr && (rr.status === 'at_risk' || rr.status === 'not_met')) {
      fails.push({ requirement: label, status: rr.status, current: rr.current, required: rr.required });
    }
  }
  return fails;
}

router.get('/rollup', requireAuth, async (req, res) => {
  const asOf = new Date();
  const hospitalIds = req.auth!.hospitalIds;
  const empty = {
    hospitals: [],
    initiatives: [],
    cells: [],
    needsAttention: [],
    totals: { hospitals: 0, enrollments: 0, met: 0, onTrack: 0, atRisk: 0, notMet: 0 },
  };
  if (hospitalIds.length === 0) {
    res.json(empty);
    return;
  }

  const allEnrollments = await db
    .select()
    .from(schema.enrollments)
    .where(inArray(schema.enrollments.hospitalId, hospitalIds));
  if (allEnrollments.length === 0) {
    res.json(empty);
    return;
  }

  const cohorts = await db.select().from(schema.cohorts);
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  // Same roster rules as /staff/overview, scoped to this user's hospitals: drop
  // pre-year withdrawals, then dedupe a (hospital, initiative) that has both a
  // current and a withdrawn enrollment.
  const enrollments = dedupeWithdrawnDuplicates(
    selectOverviewRollup(allEnrollments, asOf),
    (e) => `${e.hospitalId}::${cohortById.get(e.cohortId)?.initiativeId ?? ''}`,
  );

  const hospitals = await db
    .select()
    .from(schema.hospitals)
    .where(inArray(schema.hospitals.id, hospitalIds));
  const hospitalById = new Map(hospitals.map((h) => [h.id, h]));
  const initiatives = await db.select().from(schema.initiatives);
  const initiativeById = new Map(initiatives.map((i) => [i.id, i]));

  interface Cell {
    hospitalId: string;
    hospitalName: string;
    initiativeId: string;
    initiativeCode: string;
    initiativeName: string;
    enrollmentId: string;
    enrollmentStatus: string;
    track: 'active' | 'sustainability';
    programYear: number | null;
    overall: RequirementStatus | null;
    requirements: Record<string, RequirementStatus> | null;
    failing: Array<{ requirement: string; status: RequirementStatus; current: number; required: number }>;
  }

  const cells: Cell[] = [];
  for (const e of enrollments) {
    const cohort = cohortById.get(e.cohortId);
    if (!cohort) continue;
    const initiative = initiativeById.get(cohort.initiativeId);
    const current = pickCurrentProgramYear(await evaluateEnrollment(e.id, asOf), asOf);
    const result = current?.result ?? null;
    cells.push({
      hospitalId: e.hospitalId,
      hospitalName: hospitalById.get(e.hospitalId)?.name ?? '(unknown)',
      initiativeId: cohort.initiativeId,
      initiativeCode: initiative?.code ?? '?',
      initiativeName: initiative?.name ?? '',
      enrollmentId: e.id,
      enrollmentStatus: e.status,
      track: cohort.track,
      programYear: current?.programYear ?? null,
      overall: result?.overall ?? null,
      requirements: result
        ? Object.fromEntries(
            REQ_KEYS.map(({ key }) => [key, result[key]?.status]).filter(([, s]) => s != null) as Array<
              [string, RequirementStatus]
            >,
          )
        : null,
      failing: result ? failingRequirements(result) : [],
    });
  }

  // Hospitals + initiatives actually present in the matrix, sorted for display.
  const presentHospitals = Array.from(new Map(cells.map((c) => [c.hospitalId, c.hospitalName])))
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const presentInitiatives = Array.from(
    new Map(cells.map((c) => [c.initiativeId, { id: c.initiativeId, code: c.initiativeCode, name: c.initiativeName }])).values(),
  ).sort((a, b) => a.code.localeCompare(b.code));

  const needsAttention = cells
    .filter((c) => c.overall === 'at_risk' || c.overall === 'not_met')
    .sort((a, b) => {
      const d = ROLLUP_STATUS_ORDER[a.overall!] - ROLLUP_STATUS_ORDER[b.overall!];
      return d !== 0 ? d : a.hospitalName.localeCompare(b.hospitalName);
    })
    .map((c) => ({
      hospitalId: c.hospitalId,
      hospitalName: c.hospitalName,
      initiativeCode: c.initiativeCode,
      enrollmentId: c.enrollmentId,
      track: c.track,
      overall: c.overall,
      failing: c.failing,
    }));

  const totals = {
    hospitals: presentHospitals.length,
    enrollments: cells.length,
    met: cells.filter((c) => c.overall === 'met').length,
    onTrack: cells.filter((c) => c.overall === 'on_track').length,
    atRisk: cells.filter((c) => c.overall === 'at_risk').length,
    notMet: cells.filter((c) => c.overall === 'not_met').length,
  };

  res.json({ hospitals: presentHospitals, initiatives: presentInitiatives, cells, needsAttention, totals });
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
