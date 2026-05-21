import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { env } from '@/config/env.js';
import {
  submitInterestForm,
  listInterestForms,
  getInterestForm,
  approveInterestForm,
  declineInterestForm,
} from './interest-forms.service.js';

const router = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const submitSchema = z.object({
  initiativeCode: z.enum(['TTT', 'SPARK', 'SOAR', 'NEST']),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.string().min(1).max(200),
  facilityName: z.string().min(2).max(200),
});

// Public submission — no auth.
router.post('/', submitLimiter, async (req, res) => {
  const body = submitSchema.parse(req.body);
  const result = await submitInterestForm(body);
  res.status(201).json(result);
});

// Staff-only listing.
router.get('/', requireAuth, requireStaff, async (req, res) => {
  const query = z
    .object({
      status: z.enum(['submitted', 'reviewed', 'approved', 'declined']).optional(),
      initiativeId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    })
    .parse(req.query);
  const result = await listInterestForms(query);
  res.json(result);
});

router.get('/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const form = await getInterestForm(id);
  res.json({ interestForm: form });
});

const approveSchema = z.object({
  programYear: z.coerce.number().int().min(2025).max(2100),
  staffNotes: z.string().max(2000).optional(),
});

router.post('/:id/approve', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = approveSchema.parse(req.body);
  const result = await approveInterestForm(id, {
    reviewerUserId: req.auth!.userId,
    programYear: body.programYear,
    staffNotes: body.staffNotes,
  });
  // Only expose the password setup token in dev for easier testing.
  res.json({
    hospitalId: result.hospitalId,
    enrollmentId: result.enrollmentId,
    userId: result.userId,
    ...(env.NODE_ENV === 'development' ? { devPasswordSetupToken: result.passwordSetupToken } : {}),
  });
});

const declineSchema = z.object({
  staffNotes: z.string().max(2000).optional(),
});

router.post('/:id/decline', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const body = declineSchema.parse(req.body);
  const result = await declineInterestForm(id, {
    reviewerUserId: req.auth!.userId,
    staffNotes: body.staffNotes,
  });
  res.json(result);
});

export default router;
