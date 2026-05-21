import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '@/middleware/auth.js';
import { getTaskInstance, listTasksForEnrollment, manageTask } from './tasks.service.js';

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

export default router;
