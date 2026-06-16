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
import { v4 as uuid } from 'uuid';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import { generateTempPassword, hashPassword } from '@/modules/auth/auth.service.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import {
  credentialsEmail,
  loginUrl,
  resetPasswordAndEmail,
} from './champion-accounts.service.js';
import {
  evaluateEnrollment,
  evaluateProgramYearById,
  pickCurrentProgramYear,
  type ComplianceForProgramYear,
} from '@/modules/compliance/compliance.repository.js';
import type { RequirementStatus } from '@/modules/compliance/compliance.service.js';
import {
  dedupeWithdrawnDuplicates,
  selectInitiativeHospitals,
  selectOverviewRollup,
} from './staff.rollup.js';
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
  // to drop — so the two dashboards can never disagree on the roster. Then
  // dedupe per-(hospital, initiative): if a hospital has both a current and a
  // withdrawn enrollment under one initiative (track-flip cleanups), only the
  // current one counts.
  const allEnrollments = await db.select().from(schema.enrollments);
  const enrollments = dedupeWithdrawnDuplicates(
    selectOverviewRollup(allEnrollments, asOf),
    (e) => `${e.hospitalId}::${cohortById.get(e.cohortId)?.initiativeId ?? ''}`,
  );

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
  // Within a single initiative, dedupe per-hospital: if Valley View has both a
  // current sustainability enrollment and an obsolete withdrawn active
  // enrollment, only the current one renders. Skip dedup when the caller asks
  // to includeWithdrawn — they explicitly want to see history.
  const visibleEnrollments = query.includeWithdrawn
    ? allEnrollments
    : dedupeWithdrawnDuplicates(allEnrollments, (e) => e.hospitalId);
  const enrollments = selectInitiativeHospitals(visibleEnrollments, query.includeWithdrawn, asOf);

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

// -------- /staff/hospitals/:hospitalId/staff (roster CRUD) --------
//
// Lets CPCQC staff edit a hospital's champion roster in-app instead of going
// back to the PM workbook. The PM-workbook importer remains the source of
// truth for bulk loads — it upserts on (hospitalId, initiativeId, lower(name))
// and never deletes, so manual additions survive a workbook re-upload and
// edits to a workbook-imported row will be re-overwritten by the next import
// (which is the right behavior: the workbook stays canonical for anything
// the PM still maintains there).

const staffMemberBodySchema = z.object({
  initiativeId: z.string().uuid().nullable(),
  name: z.string().trim().min(1, 'Name is required').max(120),
  role: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(40).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

function normalizeBody(input: z.infer<typeof staffMemberBodySchema>) {
  // Treat '' as null so a cleared input doesn't store an empty string and
  // break the email-shape check on a later view.
  const blankToNull = (v: string | null | undefined) =>
    v === undefined || v === null || v === '' ? null : v;
  return {
    initiativeId: input.initiativeId,
    name: input.name,
    role: blankToNull(input.role ?? null),
    email: blankToNull(input.email ?? null),
    phone: blankToNull(input.phone ?? null),
    notes: blankToNull(input.notes ?? null),
  };
}

router.post('/hospitals/:hospitalId/staff', requireAuth, requireStaff, async (req, res) => {
  const hospitalId = z.string().uuid().parse(req.params.hospitalId);
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found');

  const body = normalizeBody(staffMemberBodySchema.parse(req.body));

  if (body.initiativeId) {
    const init = await db.query.initiatives.findFirst({
      where: eq(schema.initiatives.id, body.initiativeId),
    });
    if (!init) throw new HttpError(400, 'Unknown initiative');
  }

  // Match the importer's dedup key: (hospital, initiative, lower(name)).
  // Prevents PMs from re-adding someone the workbook already loaded.
  const existing = await db
    .select({ id: schema.hospitalStaffMembers.id })
    .from(schema.hospitalStaffMembers)
    .where(
      and(
        eq(schema.hospitalStaffMembers.hospitalId, hospitalId),
        body.initiativeId
          ? eq(schema.hospitalStaffMembers.initiativeId, body.initiativeId)
          : sql`${schema.hospitalStaffMembers.initiativeId} IS NULL`,
        sql`lower(${schema.hospitalStaffMembers.name}) = lower(${body.name})`,
      ),
    )
    .limit(1);
  if (existing.length) {
    throw new HttpError(
      409,
      `${body.name} is already on this hospital's roster for this initiative. Edit the existing row instead.`,
    );
  }

  const id = uuid();
  await db.insert(schema.hospitalStaffMembers).values({
    id,
    hospitalId,
    ...body,
  });
  const created = await db.query.hospitalStaffMembers.findFirst({
    where: eq(schema.hospitalStaffMembers.id, id),
  });
  res.status(201).json({ staffMember: created });
});

router.patch(
  '/hospitals/:hospitalId/staff/:staffId',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const hospitalId = z.string().uuid().parse(req.params.hospitalId);
    const staffId = z.string().uuid().parse(req.params.staffId);

    const existing = await db.query.hospitalStaffMembers.findFirst({
      where: and(
        eq(schema.hospitalStaffMembers.id, staffId),
        eq(schema.hospitalStaffMembers.hospitalId, hospitalId),
      ),
    });
    if (!existing) throw new HttpError(404, 'Staff member not found');

    const body = normalizeBody(staffMemberBodySchema.parse(req.body));

    if (body.initiativeId) {
      const init = await db.query.initiatives.findFirst({
        where: eq(schema.initiatives.id, body.initiativeId),
      });
      if (!init) throw new HttpError(400, 'Unknown initiative');
    }

    // Re-check uniqueness only if name or initiative changed, and only against
    // OTHER rows (so saving an unchanged row doesn't false-positive on itself).
    const movedOrRenamed =
      body.name.toLowerCase() !== existing.name.toLowerCase() ||
      body.initiativeId !== existing.initiativeId;
    if (movedOrRenamed) {
      const dupes = await db
        .select({ id: schema.hospitalStaffMembers.id })
        .from(schema.hospitalStaffMembers)
        .where(
          and(
            eq(schema.hospitalStaffMembers.hospitalId, hospitalId),
            body.initiativeId
              ? eq(schema.hospitalStaffMembers.initiativeId, body.initiativeId)
              : sql`${schema.hospitalStaffMembers.initiativeId} IS NULL`,
            sql`lower(${schema.hospitalStaffMembers.name}) = lower(${body.name})`,
            sql`${schema.hospitalStaffMembers.id} <> ${staffId}`,
          ),
        )
        .limit(1);
      if (dupes.length) {
        throw new HttpError(
          409,
          `Another roster row for ${body.name} on this initiative already exists.`,
        );
      }
    }

    await db
      .update(schema.hospitalStaffMembers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.hospitalStaffMembers.id, staffId));

    const updated = await db.query.hospitalStaffMembers.findFirst({
      where: eq(schema.hospitalStaffMembers.id, staffId),
    });
    res.json({ staffMember: updated });
  },
);

router.delete(
  '/hospitals/:hospitalId/staff/:staffId',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const hospitalId = z.string().uuid().parse(req.params.hospitalId);
    const staffId = z.string().uuid().parse(req.params.staffId);

    const existing = await db.query.hospitalStaffMembers.findFirst({
      where: and(
        eq(schema.hospitalStaffMembers.id, staffId),
        eq(schema.hospitalStaffMembers.hospitalId, hospitalId),
      ),
    });
    if (!existing) throw new HttpError(404, 'Staff member not found');

    await db
      .delete(schema.hospitalStaffMembers)
      .where(eq(schema.hospitalStaffMembers.id, staffId));
    res.status(204).end();
  },
);

// -------- /staff/users (multi-hospital access management) --------
//
// Lets CPCQC staff grant a hospital user access to additional hospitals
// (regional staff covering several sites in their system). Manages the
// user_hospitals grants; the primary users.hospital_id is shown but not
// edited here.

// Find hospital users to manage. Search matches email / first / last name.
router.get('/users', requireAuth, requireStaff, async (req, res) => {
  const search = z.string().trim().max(200).optional().parse(req.query.search);
  const conditions = [
    inArray(schema.users.role, ['hospital_user', 'hospital_admin'] as const),
    // Hide removed champions — a deactivated account can't sign in and
    // shouldn't clutter the list. (It's recoverable; see the deactivate route.)
    isNull(schema.users.deactivatedAt),
  ];
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${schema.users.email}) LIKE ${like}
        OR lower(coalesce(${schema.users.firstName}, '')) LIKE ${like}
        OR lower(coalesce(${schema.users.lastName}, '')) LIKE ${like})`,
    );
  }
  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      role: schema.users.role,
      primaryHospitalId: schema.users.hospitalId,
    })
    .from(schema.users)
    .where(and(...conditions))
    .orderBy(schema.users.email)
    .limit(50);

  // Count of additional hospital grants per user (for the list view).
  const userIds = rows.map((r) => r.id);
  const grantCounts = new Map<string, number>();
  if (userIds.length) {
    const counts = await db
      .select({
        userId: schema.userHospitals.userId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.userHospitals)
      .where(inArray(schema.userHospitals.userId, userIds))
      .groupBy(schema.userHospitals.userId);
    for (const c of counts) grantCounts.set(c.userId, c.count);
  }
  const hospitalNameById = new Map(
    (
      await db
        .select({ id: schema.hospitals.id, name: schema.hospitals.name })
        .from(schema.hospitals)
    ).map((h) => [h.id, h.name]),
  );

  // Champion roster title(s) per user, matched by email. A champion can hold
  // a role on more than one initiative's roster, so we collect the distinct
  // set. The roster is small (~240 rows), so loading it all and mapping in
  // memory is cheaper than a per-user join.
  const rolesByEmail = new Map<string, Set<string>>();
  const rosterRows = await db
    .select({
      email: schema.hospitalStaffMembers.email,
      role: schema.hospitalStaffMembers.role,
    })
    .from(schema.hospitalStaffMembers)
    .where(
      and(
        isNotNull(schema.hospitalStaffMembers.email),
        isNotNull(schema.hospitalStaffMembers.role),
      ),
    );
  for (const rr of rosterRows) {
    if (!rr.email || !rr.role) continue;
    const key = rr.email.toLowerCase();
    if (!rolesByEmail.has(key)) rolesByEmail.set(key, new Set());
    rolesByEmail.get(key)!.add(rr.role);
  }

  res.json({
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      role: r.role,
      championRoles: Array.from(rolesByEmail.get(r.email.toLowerCase()) ?? []).sort(),
      primaryHospital: r.primaryHospitalId
        ? { id: r.primaryHospitalId, name: hospitalNameById.get(r.primaryHospitalId) ?? '—' }
        : null,
      additionalCount: grantCounts.get(r.id) ?? 0,
    })),
  });
});

// Email-delivery diagnostic. Sends a fixed test message and reports whether
// it actually went out — so staff can verify the email provider end-to-end
// (and distinguish "no provider configured" from "provider rejected it").
router.post('/email-test', requireAuth, requireStaff, async (req, res) => {
  const { toEmail } = z.object({ toEmail: z.string().trim().email() }).parse(req.body);
  const configured = !!env.SENDGRID_API_KEY;

  const result = await sendEmail({
    toEmail,
    subject: 'CPCQC Engagement Tracker — test email',
    kind: 'admin.test',
    body:
      'This is a test email from the CPCQC Engagement Tracker.\n\n' +
      'If you received it, outbound email is working — champion welcome emails, ' +
      'interest-form confirmations, and acceptance notices will send.\n\n' +
      'You can ignore this message.',
  });

  // Pull the recorded reason when it didn't send.
  let error: string | null = null;
  if (!result.sent) {
    if (!configured) {
      error =
        'No email provider is configured (SENDGRID_API_KEY is not set), so email is logged only. ' +
        'Set up SendGrid + a verified sender to enable real delivery.';
    } else {
      const row = await db.query.notifications.findFirst({
        where: eq(schema.notifications.id, result.id),
      });
      error = row?.error ?? 'Send failed — check the server logs.';
    }
  }

  res.json({
    configured,
    sent: result.sent,
    fromAddress: env.EMAIL_FROM,
    error,
  });
});

// Create a new hospital champion account. PMs use this from the Access tab to
// onboard a champion without the bulk CLI. Generates a strong temp password
// and returns it ONCE so the PM can relay it; the champion rotates it via
// Account → Change password on first login.
router.post('/users', requireAuth, requireStaff, async (req, res) => {
  const body = z
    .object({
      firstName: z.string().trim().min(1).max(120),
      lastName: z.string().trim().max(120).optional(),
      email: z.string().trim().toLowerCase().email().max(254),
      hospitalId: z.string().uuid(),
      // Which initiative this person champions — hospitals can have distinct
      // champions per initiative. Used to add them to that initiative's roster.
      initiativeCode: z.enum(['TTT', 'SPARK', 'SOAR', 'NEST']),
      // The champion's roster title (e.g. "QI Champion", "Data Champion").
      // Free text so the long tail (CNO, VP of Nursing, etc.) is supported.
      championRole: z.string().trim().min(1).max(120),
      // Account permission level. The portal doesn't differentiate these for
      // hospital users today, so it's not exposed in the UI; defaults to admin
      // for parity with the existing accounts.
      role: z.enum(['hospital_admin', 'hospital_user']).default('hospital_admin'),
    })
    .parse(req.body);

  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, body.hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found');

  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, body.initiativeCode),
  });
  if (!initiative) throw new HttpError(400, 'Unknown initiative');

  // Friendly pre-check; the unique index on lower(email) is the backstop.
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${body.email}`)
    .limit(1);
  if (existing.length) {
    throw new HttpError(409, 'An account with that email already exists.');
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const id = uuid();
  await db.insert(schema.users).values({
    id,
    email: body.email,
    passwordHash,
    firstName: body.firstName,
    lastName: body.lastName || null,
    role: body.role,
    hospitalId: body.hospitalId,
  });

  // Add them to the chosen initiative's roster so they appear in the right
  // group on the hospital detail page. Dedup on (hospital, initiative,
  // lower(name)) — matches the roster importer/editor — so a champion already
  // on the roster (e.g. from a workbook) gets their email filled in rather
  // than duplicated.
  const championName = [body.firstName, body.lastName].filter(Boolean).join(' ');
  const existingRoster = await db
    .select({ id: schema.hospitalStaffMembers.id })
    .from(schema.hospitalStaffMembers)
    .where(
      and(
        eq(schema.hospitalStaffMembers.hospitalId, body.hospitalId),
        eq(schema.hospitalStaffMembers.initiativeId, initiative.id),
        sql`lower(${schema.hospitalStaffMembers.name}) = lower(${championName})`,
      ),
    )
    .limit(1);
  if (existingRoster.length) {
    await db
      .update(schema.hospitalStaffMembers)
      .set({ email: body.email, role: body.championRole, updatedAt: new Date() })
      .where(eq(schema.hospitalStaffMembers.id, existingRoster[0]!.id));
  } else {
    await db.insert(schema.hospitalStaffMembers).values({
      id: uuid(),
      hospitalId: body.hospitalId,
      initiativeId: initiative.id,
      name: championName,
      role: body.championRole,
      email: body.email,
    });
  }

  // Email the champion their sign-in details directly.
  const url = loginUrl();
  const { subject, body: emailBody } = credentialsEmail({
    firstName: body.firstName,
    hospitalName: hospital.name,
    email: body.email,
    tempPassword,
    url,
    reason: 'welcome',
  });
  const sendResult = await sendEmail({
    toEmail: body.email,
    subject,
    kind: 'champion.welcome',
    userId: id,
    body: emailBody,
  });

  // sendEmail never throws — it returns sent=false in dev (no SendGrid key)
  // or on a delivery failure. Only hand the plaintext back to the PM when the
  // email did NOT go out, so they can relay it manually instead of the
  // champion being locked out. When it sent, the password stays out of the
  // response entirely.
  const emailed = sendResult.sent;
  res.status(201).json({
    user: {
      id,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName ?? null,
      role: body.role,
      hospital: { id: hospital.id, name: hospital.name },
      initiative: { code: initiative.code, name: initiative.name },
    },
    emailed,
    loginUrl: url,
    tempPassword: emailed ? null : tempPassword,
  });
});

// Reset a champion's password and email them new credentials. General-purpose
// recovery (champion forgot / never activated). Returns whether the email
// sent; on failure returns the temp password for manual relay.
router.post('/users/:userId/reset-password', requireAuth, requireStaff, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  const result = await resetPasswordAndEmail(userId, 'reset');
  res.json(result);
});

/**
 * Remove (deactivate) a champion. Soft-delete: sets deactivated_at so the
 * account can no longer sign in (login filters on it) and revokes any live
 * sessions, but the user row, roster entry, and audit history stay intact —
 * so this is reversible and doesn't orphan compliance records. Only hospital
 * champions can be removed here; CPCQC staff/admin accounts are off-limits.
 */
router.post('/users/:userId/deactivate', requireAuth, requireStaff, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role !== 'hospital_user' && user.role !== 'hospital_admin') {
    throw new HttpError(400, 'Only hospital champion accounts can be removed here.');
  }
  if (user.deactivatedAt) {
    res.json({ id: user.id, deactivatedAt: user.deactivatedAt.toISOString() });
    return;
  }

  const now = new Date();
  await db
    .update(schema.users)
    .set({ deactivatedAt: now, updatedAt: now })
    .where(eq(schema.users.id, userId));

  // Kill any live sessions immediately (the 15-min access token aside).
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)));

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: req.auth?.userId ?? null,
    actorRole: req.auth?.role ?? null,
    action: 'user.deactivate',
    entityType: 'user',
    entityId: userId,
    diff: { deactivatedAt: { from: null, to: now.toISOString() } },
    note: `Champion ${user.email} removed from access.`,
  });

  res.json({ id: userId, deactivatedAt: now.toISOString() });
});

// A single user's hospital access — primary + additional grants.
router.get('/users/:userId/hospitals', requireAuth, requireStaff, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');

  const grants = await db
    .select({
      id: schema.userHospitals.id,
      hospitalId: schema.userHospitals.hospitalId,
      name: schema.hospitals.name,
    })
    .from(schema.userHospitals)
    .innerJoin(schema.hospitals, eq(schema.hospitals.id, schema.userHospitals.hospitalId))
    .where(eq(schema.userHospitals.userId, userId));

  const primary = user.hospitalId
    ? await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, user.hospitalId) })
    : null;

  res.json({
    user: { id: user.id, email: user.email, role: user.role },
    primaryHospital: primary ? { id: primary.id, name: primary.name } : null,
    additionalHospitals: grants
      .map((g) => ({ id: g.hospitalId, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// Grant a user access to an additional hospital.
router.post('/users/:userId/hospitals', requireAuth, requireStaff, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  const { hospitalId } = z.object({ hospitalId: z.string().uuid() }).parse(req.body);

  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role !== 'hospital_user' && user.role !== 'hospital_admin') {
    throw new HttpError(400, 'Only hospital users can be granted hospital access.');
  }
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found');
  if (user.hospitalId === hospitalId) {
    throw new HttpError(409, 'That is already the user’s primary hospital.');
  }
  const dupe = await db
    .select({ id: schema.userHospitals.id })
    .from(schema.userHospitals)
    .where(
      and(
        eq(schema.userHospitals.userId, userId),
        eq(schema.userHospitals.hospitalId, hospitalId),
      ),
    )
    .limit(1);
  if (dupe.length) throw new HttpError(409, 'User already has access to that hospital.');

  await db.insert(schema.userHospitals).values({ id: uuid(), userId, hospitalId });
  res.status(201).json({ hospital: { id: hospital.id, name: hospital.name } });
});

// Revoke an additional-hospital grant. (The primary is not managed here.)
router.delete(
  '/users/:userId/hospitals/:hospitalId',
  requireAuth,
  requireStaff,
  async (req, res) => {
    const userId = z.string().uuid().parse(req.params.userId);
    const hospitalId = z.string().uuid().parse(req.params.hospitalId);
    const existing = await db
      .select({ id: schema.userHospitals.id })
      .from(schema.userHospitals)
      .where(
        and(
          eq(schema.userHospitals.userId, userId),
          eq(schema.userHospitals.hospitalId, hospitalId),
        ),
      )
      .limit(1);
    if (!existing.length) throw new HttpError(404, 'Grant not found.');
    await db
      .delete(schema.userHospitals)
      .where(
        and(
          eq(schema.userHospitals.userId, userId),
          eq(schema.userHospitals.hospitalId, hospitalId),
        ),
      );
    res.status(204).end();
  },
);

export default router;
