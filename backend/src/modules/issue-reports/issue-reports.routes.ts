/**
 * Issue Reports — submit, list, triage.
 *
 *   POST   /issue-reports           any authed user submits a report
 *   GET    /issue-reports           (staff only) list reports, filtered/paged
 *   PATCH  /issue-reports/:id       (staff only) update status / resolution
 *
 * On create, a notification email is sent to qi@cpcqc.org so staff don't have
 * to actively check the dashboard. Reporter identity is snapshotted onto the
 * row so later user deletion doesn't orphan attribution.
 */
import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';

const router = Router();

const REPORT_RECIPIENT = 'qi@cpcqc.org';

const createBody = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(5).max(10_000),
  category: z.enum(['bug', 'data_correction', 'feature_request', 'other']).default('other'),
});

router.post('/', requireAuth, async (req, res) => {
  const parsed = createBody.parse(req.body);
  const auth = req.auth!;

  // Snapshot identity from the users row at submission time.
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, auth.userId),
  });
  if (!user) throw new HttpError(500, 'Authed user not found');

  const id = uuid();
  const [row] = await db
    .insert(schema.issueReports)
    .values({
      id,
      reporterUserId: auth.userId,
      reporterEmail: user.email,
      reporterRole: auth.role,
      reporterHospitalId: auth.hospitalId,
      subject: parsed.subject,
      body: parsed.body,
      category: parsed.category,
      status: 'open',
    })
    .returning();

  // Best-effort email — log and continue if email service is misconfigured.
  // The DB row is the source of truth either way.
  try {
    const hospital = auth.hospitalId
      ? await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, auth.hospitalId) })
      : null;
    const lines = [
      `From: ${user.email} (${auth.role}${hospital ? ` — ${hospital.name}` : ''})`,
      `Category: ${parsed.category}`,
      `Submitted: ${new Date().toISOString()}`,
      '',
      parsed.body,
      '',
      `Issue ID: ${id}`,
      `View in dashboard: /staff/issue-reports`,
    ];
    await sendEmail({
      toEmail: REPORT_RECIPIENT,
      subject: `[Issue Report] ${parsed.subject}`,
      body: lines.join('\n'),
      kind: 'issue_report',
      userId: auth.userId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[issue-reports] email send failed:', err);
  }

  res.status(201).json({ report: row });
});

// -------- Staff: list + triage --------

const listQuery = z.object({
  status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', requireAuth, requireStaff, async (req, res) => {
  const query = listQuery.parse(req.query);
  const conditions = [];
  if (query.status) conditions.push(eq(schema.issueReports.status, query.status));
  const rows = await db
    .select()
    .from(schema.issueReports)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.issueReports.createdAt))
    .limit(query.limit);
  res.json({ reports: rows });
});

const patchBody = z.object({
  status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  resolutionNote: z.string().max(5000).nullable().optional(),
});

router.patch('/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const parsed = patchBody.parse(req.body);
  const existing = await db.query.issueReports.findFirst({
    where: eq(schema.issueReports.id, id),
  });
  if (!existing) throw new HttpError(404, 'Issue report not found');

  const now = new Date();
  const transitioningToResolved =
    parsed.status === 'resolved' && existing.status !== 'resolved';
  const transitioningAwayFromResolved =
    parsed.status && parsed.status !== 'resolved' && existing.status === 'resolved';

  const [updated] = await db
    .update(schema.issueReports)
    .set({
      ...(parsed.status !== undefined && { status: parsed.status }),
      ...(parsed.resolutionNote !== undefined && { resolutionNote: parsed.resolutionNote }),
      ...(transitioningToResolved && { resolvedAt: now, resolvedBy: req.auth!.userId }),
      ...(transitioningAwayFromResolved && { resolvedAt: null, resolvedBy: null }),
      updatedAt: now,
    })
    .where(eq(schema.issueReports.id, id))
    .returning();
  res.json({ report: updated });
});

export default router;
