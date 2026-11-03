import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth.js';
import {
  getQiYearSummary,
  getTaskInstance,
  listTasksForEnrollment,
  manageTask,
  setTaskNote,
  updateAdvisingContent,
} from './tasks.service.js';
import { renderQiSummaryPdf } from './qi-summary-pdf.js';

const router = Router();

router.get('/enrollment/:enrollmentId', requireAuth, async (req, res) => {
  const enrollmentId = z.string().uuid().parse(req.params.enrollmentId);
  const query = z
    .object({
      programYear: z.coerce.number().int().min(2025).max(2100).optional(),
      status: z.enum(['not_started', 'current_activities', 'complete', 'needs_revision']).optional(),
    })
    .parse(req.query);
  const tasks = await listTasksForEnrollment(
    { enrollmentId, programYear: query.programYear, status: query.status },
    req.auth!,
  );
  res.json({ tasks });
});

// The end-of-year QI summary PDF, offered from the year's Q4 1:1.
router.get('/enrollment/:enrollmentId/qi-summary', requireAuth, async (req, res) => {
  const enrollmentId = z.string().uuid().parse(req.params.enrollmentId);
  const { year } = z
    .object({ year: z.coerce.number().int().min(2025).max(2100) })
    .parse(req.query);
  const data = await getQiYearSummary(enrollmentId, year, req.auth!);
  const pdf = await renderQiSummaryPdf(data);
  const filename = `QI-summary-${year}-${data.initiativeCode}-${data.hospitalName}`.replace(
    /[^A-Za-z0-9_.-]/g,
    '_',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  res.setHeader('Content-Type', 'application/pdf');
  res.send(pdf);
});

router.get('/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const task = await getTaskInstance(id, req.auth!);
  res.json({ task });
});

router.post('/:id/manage', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const updated = await manageTask(id, req.body, req.auth!);
  res.json({ task: updated });
});

// Note-only update — available to hospital users (on their hospital's tasks)
// and CPCQC staff. `staffNote` is required: a string saves, `null` clears.
// Separate from /manage so the permission story is unambiguous — task status,
// outcome, and per-type payload are staff-only via /manage.
router.patch('/:id/note', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = z
    .object({
      staffNote: z.string().max(5000).nullable(),
    })
    .parse(req.body);
  const updated = await setTaskNote(id, body.staffNote, req.auth!);
  res.json({ task: updated });
});

// QI 1:1 call notes and aims — hospital users (their hospital's 1:1s) and
// CPCQC staff. Attendance and the session's own details stay on /manage.
router.patch('/:id/advising', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const updated = await updateAdvisingContent(id, req.body, req.auth!);
  res.json({ task: updated });
});

export default router;
