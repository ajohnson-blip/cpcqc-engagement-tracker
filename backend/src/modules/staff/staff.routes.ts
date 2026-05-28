/**
 * Staff dashboard endpoints.
 *
 * GET /staff/overview
 *   The program-manager home page. Across all initiatives, returns:
 *     - per-initiative summary counts (met, on_track, at_risk, not_met)
 *     - a "needs attention" list of hospital × initiative × programYear
 *       sorted worst-first (this is the recommended departure from a purely
 *       alphabetical list — answers the most common question quickly)
 *     - new interest forms pending review
 *
 * GET /staff/initiatives/:code/hospitals
 *   Per-initiative hospital list, mirroring the screenshots' "Manage Hospitals"
 *   table, but with compliance status as a first-class column and
 *   compliance-priority sort by default.
 *
 * GET /staff/hospitals/:id
 *   Hospital detail: contact info, every enrollment across years, compliance
 *   per program year, recent audit log entries.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import {
  evaluateEnrollment,
  evaluateProgramYearById,
  pickCurrentProgramYear,
  type ComplianceForProgramYear,
} from '@/modules/compliance/compliance.repository.js';
import type { RequirementStatus } from '@/modules/compliance/compliance.service.js';
import { selectInitiativeHospitals, selectOverviewRollup } from './staff.rollup.js';
import { getTeamForInitiativeId } from './staff-team.service.js';

const router = Router();

const STATUS_ORDER: Record<RequirementStatus, number> = {
  not_met: 0,
  at_risk: 1,
  on_track: 2,
  met: 3,
};

function compareByCompliance(a: RequirementStatus, b: RequirementStatus): number {
  return STATUS_ORDER[a] - STATUS_ORDER[b];
}

// -------- /staff/overview --------

router.get('/overview', requireAuth, requireStaff, async (_req, res) => {
  const asOf = new Date();
  const initiatives = await db.select().from(schema.initiatives);
  const cohorts = await db.select().from(schema.cohorts);
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  // Pull the same set of enrollments the initiative roster does (every
  // enrollment, withdrawn included), then let isExcludedFromRollup decide what
  // to drop — so the two dashboards can never disagree on the roster.
  const allEnrollments = await db.select().from(schema.enrollments);
  const enrollments = selectOverviewRollup(allEnrollments, asOf);

  const hospitalIds = Array.from(new Set(enrollments.map((e) => e.hospitalId)));
  const hospitals = hospitalIds.length
    ? await db.select().from(schema.hospitals).where(inArray(schema.hospitals.id, hospitalIds))
    : [];
  const hospitalById = new Map(hospitals.map((h) => [h.id, h]));

  // Evaluate every enrollment's current program year compliance
  interface ComplianceRow {
    hospitalId: string;
    hospitalName: string;
    initiativeId: string;
    initiativeCode: string;
    enrollmentId: string;
    enrollmentStatus: string;
    track: 'active' | 'sustainability';
    compliance: ComplianceForProgramYear | null;
  }

  const rows: ComplianceRow[] = [];
  for (const e of enrollments) {
    const cohort = cohortById.get(e.cohortId);
    if (!cohort) continue;
    const evaluations = await evaluateEnrollment(e.id, asOf);
    const current = pickCurrentProgramYear(evaluations, asOf);
    rows.push({
      hospitalId: e.hospitalId,
      hospitalName: hospitalById.get(e.hospitalId)?.name ?? '(unknown)',
      initiativeId: cohort.initiativeId,
      initiativeCode: current?.initiativeCode ?? '?',
      enrollmentId: e.id,
      enrollmentStatus: e.status,
      track: cohort.track,
      compliance: current,
    });
  }

  // Per-initiative counts
  const byInitiative = new Map<
    string,
    {
      initiativeId: string;
      code: string;
      name: string;
      enrolled: number;
      met: number;
      onTrack: number;
      atRisk: number;
      notMet: number;
    }
  >();
  for (const ini of initiatives) {
    byInitiative.set(ini.id, {
      initiativeId: ini.id,
      code: ini.code,
      name: ini.name,
      enrolled: 0,
      met: 0,
      onTrack: 0,
      atRisk: 0,
      notMet: 0,
    });
  }
  for (const row of rows) {
    const bucket = byInitiative.get(row.initiativeId);
    if (!bucket) continue;
    bucket.enrolled += 1;
    const overall = row.compliance?.result.overall;
    if (overall === 'met') bucket.met += 1;
    else if (overall === 'on_track') bucket.onTrack += 1;
    else if (overall === 'at_risk') bucket.atRisk += 1;
    else if (overall === 'not_met') bucket.notMet += 1;
  }

  // Needs-attention list (at_risk + not_met), sorted worst-first
  const needsAttention = rows
    .filter((r) => r.compliance && ['at_risk', 'not_met'].includes(r.compliance.result.overall))
    .sort((a, b) => {
      const sa = a.compliance!.result.overall;
      const sb = b.compliance!.result.overall;
      if (sa !== sb) return compareByCompliance(sa, sb);
      return a.hospitalName.localeCompare(b.hospitalName);
    })
    .slice(0, 30);

  // Interest forms pending review
  const pendingInterestForms = await db
    .select()
    .from(schema.interestForms)
    .where(eq(schema.interestForms.status, 'submitted'))
    .orderBy(desc(schema.interestForms.createdAt))
    .limit(20);

  res.json({
    initiatives: Array.from(byInitiative.values()),
    needsAttention,
    pendingInterestForms,
    totals: {
      hospitalsEnrolled: hospitalIds.length,
      totalEnrollments: enrollments.length,
      pendingInterestForms: pendingInterestForms.length,
    },
  });
});

// -------- /staff/initiatives/:code/hospitals --------

router.get('/initiatives/:code/hospitals', requireAuth, requireStaff, async (req, res) => {
  const asOf = new Date();
  const code = z.enum(['TTT', 'SPARK', 'SOAR', 'NEST']).parse(req.params.code);
  const query = z
    .object({
      track: z.enum(['active', 'sustainability']).optional(),
      sort: z.enum(['compliance', 'name']).default('compliance'),
      search: z.string().optional(),
      // Withdrawn-before-this-program-year enrollments are hidden by default so
      // this roster matches the /overview rollup; pass includeWithdrawn=true to
      // see them.
      includeWithdrawn: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => v === 'true'),
    })
    .parse(req.query);

  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, code),
  });
  if (!initiative) throw new HttpError(404, 'Initiative not found');

  const cohortConditions = [eq(schema.cohorts.initiativeId, initiative.id)];
  if (query.track) cohortConditions.push(eq(schema.cohorts.track, query.track));
  const cohorts = await db.select().from(schema.cohorts).where(and(...cohortConditions));
  const cohortIds = cohorts.map((c) => c.id);
  if (cohortIds.length === 0) {
    res.json({ initiative, hospitals: [] });
    return;
  }

  const allEnrollments = await db
    .select()
    .from(schema.enrollments)
    .where(inArray(schema.enrollments.cohortId, cohortIds));
  const enrollments = selectInitiativeHospitals(allEnrollments, query.includeWithdrawn, asOf);

  const hospitalIds = Array.from(new Set(enrollments.map((e) => e.hospitalId)));
  const hospitals = hospitalIds.length
    ? await db.select().from(schema.hospitals).where(inArray(schema.hospitals.id, hospitalIds))
    : [];
  const stageIds = enrollments.map((e) => e.currentStageId).filter((s): s is string => !!s);
  const stages = stageIds.length
    ? await db.select().from(schema.stages).where(inArray(schema.stages.id, stageIds))
    : [];
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  // Optional search filter
  let filteredHospitals = hospitals;
  if (query.search) {
    const needle = query.search.toLowerCase();
    filteredHospitals = hospitals.filter((h) => h.name.toLowerCase().includes(needle));
  }
  const filteredIds = new Set(filteredHospitals.map((h) => h.id));

  const out = await Promise.all(
    enrollments
      .filter((e) => filteredIds.has(e.hospitalId))
      .map(async (e) => {
        const hospital = filteredHospitals.find((h) => h.id === e.hospitalId)!;
        const cohort = cohortById.get(e.cohortId);
        const stage = e.currentStageId ? stageById.get(e.currentStageId) : null;
        const evaluations = await evaluateEnrollment(e.id, asOf);
        const current = pickCurrentProgramYear(evaluations, asOf);
        return {
          hospital: {
            id: hospital.id,
            name: hospital.name,
            region: hospital.region,
            defaultContactName: hospital.defaultContactName,
            defaultContactEmail: hospital.defaultContactEmail,
          },
          enrollmentId: e.id,
          enrollmentStatus: e.status,
          cohort: cohort
            ? { id: cohort.id, label: cohort.label, track: cohort.track }
            : null,
          currentStage: stage
            ? { id: stage.id, code: stage.code, name: stage.name, sequence: stage.sequence }
            : null,
          compliance: current,
        };
      }),
  );

  if (query.sort === 'name') {
    out.sort((a, b) => a.hospital.name.localeCompare(b.hospital.name));
  } else {
    out.sort((a, b) => {
      const sa = a.compliance?.result.overall ?? 'met';
      const sb = b.compliance?.result.overall ?? 'met';
      if (sa !== sb) return compareByCompliance(sa, sb);
      return a.hospital.name.localeCompare(b.hospital.name);
    });
  }

  res.json({
    initiative: {
      id: initiative.id,
      code: initiative.code,
      name: initiative.name,
      brandColor: initiative.brandColor,
      emoji: initiative.emoji,
    },
    hospitals: out,
  });
});

// -------- /staff/hospitals/:id --------

router.get('/hospitals/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const hospital = await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, id) });
  if (!hospital) throw new HttpError(404, 'Hospital not found');

  const enrollments = await db
    .select()
    .from(schema.enrollments)
    .where(eq(schema.enrollments.hospitalId, id));

  const cohortIds = enrollments.map((e) => e.cohortId);
  const cohorts = cohortIds.length
    ? await db.select().from(schema.cohorts).where(inArray(schema.cohorts.id, cohortIds))
    : [];
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const initiativeIds = Array.from(new Set(cohorts.map((c) => c.initiativeId)));
  const initiatives = initiativeIds.length
    ? await db.select().from(schema.initiatives).where(inArray(schema.initiatives.id, initiativeIds))
    : [];
  const initiativeById = new Map(initiatives.map((i) => [i.id, i]));

  const stageIds = enrollments.map((e) => e.currentStageId).filter((s): s is string => !!s);
  const stages = stageIds.length
    ? await db.select().from(schema.stages).where(inArray(schema.stages.id, stageIds))
    : [];
  const stageById = new Map(stages.map((s) => [s.id, s]));

  const enrollmentDetails = await Promise.all(
    enrollments.map(async (e) => {
      const cohort = cohortById.get(e.cohortId);
      const initiative = cohort ? initiativeById.get(cohort.initiativeId) : null;
      const stage = e.currentStageId ? stageById.get(e.currentStageId) : null;
      return {
        enrollmentId: e.id,
        status: e.status,
        enrolledOn: e.enrolledOn,
        withdrawnOn: e.withdrawnOn,
        cohort: cohort
          ? {
              id: cohort.id,
              label: cohort.label,
              track: cohort.track,
              startDate: cohort.startDate,
              endDate: cohort.endDate,
            }
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
        programYears: await evaluateEnrollment(e.id),
      };
    }),
  );

  // Hospital staff roster (Clinical Lead / QI Champion / etc.)
  const staffMembers = await db
    .select()
    .from(schema.hospitalStaffMembers)
    .where(eq(schema.hospitalStaffMembers.hospitalId, id));

  // Recent audit entries for this hospital's enrollments
  const enrollmentIds = enrollments.map((e) => e.id);
  const recentAudit = enrollmentIds.length
    ? await db
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.entityType, 'enrollment'), inArray(schema.auditLog.entityId, enrollmentIds)),
        )
        .orderBy(desc(schema.auditLog.createdAt))
        .limit(30)
    : [];

  res.json({
    hospital,
    enrollments: enrollmentDetails,
    staffMembers,
    recentAudit,
  });
});

// -------- /staff/initiatives/:code/team --------

router.get('/initiatives/:code/team', requireAuth, requireStaff, async (req, res) => {
  const code = z.enum(['TTT', 'SPARK', 'SOAR', 'NEST']).parse(req.params.code);
  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, code),
  });
  if (!initiative) throw new HttpError(404, 'Initiative not found');
  const team = await getTeamForInitiativeId(initiative.id);
  res.json({ team });
});

// -------- /staff/program-years/:id/compliance (drilldown) --------

router.get('/program-years/:id/compliance', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const result = await evaluateProgramYearById(id);
  res.json({ compliance: result });
});

export default router;
