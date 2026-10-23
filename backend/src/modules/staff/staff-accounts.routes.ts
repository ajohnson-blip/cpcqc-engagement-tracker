/**
 * CPCQC staff accounts — admin only.
 *
 *   GET  /staff/team                      the CPCQC staff and admin accounts
 *   POST /staff/team                      add a staff member and email a setup link
 *   POST /staff/team/:userId/setup-link   email a fresh setup link
 *   POST /staff/team/:userId/deactivate   remove a staff member's access
 *
 * Champion (hospital) accounts are managed under /staff/users, by any staff.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '@/middleware/auth.js';
import {
  createStaffAccount,
  deactivateStaffAccount,
  listStaffAccounts,
  sendStaffSetupLink,
  STAFF_APP_ROLES,
} from './staff-accounts.service.js';

const router = Router();

router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ staff: await listStaffAccounts() });
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const body = z
    .object({
      firstName: z.string().trim().min(1).max(120),
      lastName: z.string().trim().max(120).optional(),
      email: z.string().trim().toLowerCase().email().max(254),
      role: z.enum(STAFF_APP_ROLES),
      // Program Manager / QI Advisor per initiative. Empty for cross-org roles.
      assignments: z
        .array(
          z.object({
            initiativeCode: z.enum(['TTT', 'SPARK', 'SOAR', 'NEST']),
            role: z.enum(['program_manager', 'qi_advisor']),
          }),
        )
        .max(8)
        .default([]),
    })
    .parse(req.body);
  const result = await createStaffAccount(body, req.auth?.userId ?? null);
  res.status(201).json(result);
});

router.post('/:userId/setup-link', requireAuth, requireAdmin, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  res.json(await sendStaffSetupLink(userId, req.auth?.userId ?? null, 'resend'));
});

router.post('/:userId/deactivate', requireAuth, requireAdmin, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  res.json(await deactivateStaffAccount(userId, req.auth?.userId ?? null));
});

export default router;
