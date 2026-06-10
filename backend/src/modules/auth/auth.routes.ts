import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { requireAuth } from '@/middleware/auth.js';
import { db, schema } from '@/db/index.js';
import { eq } from 'drizzle-orm';
import {
  changePassword,
  login,
  logout,
  refresh,
  requestPasswordReset,
  confirmPasswordReset,
} from './auth.service.js';

const router = Router();

const REFRESH_COOKIE = 'cpcqc_refresh';

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
    path: '/',
    maxAge: env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

router.post('/login', async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body);
  const result = await login(body.email, body.password);
  setRefreshCookie(res, result.refreshToken);
  res.json({ accessToken: result.accessToken, user: result.auth });
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await logout(token);
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.status(204).end();
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new HttpError(401, 'Missing refresh token');
  const result = await refresh(token);
  setRefreshCookie(res, result.refreshToken);
  res.json({ accessToken: result.accessToken, user: result.auth });
});

router.post('/password-reset/request', async (req, res) => {
  const body = z.object({ email: z.string().email() }).parse(req.body);
  // Token is returned for dev only. In production this is emailed and not sent in response.
  const token = await requestPasswordReset(body.email);
  if (env.NODE_ENV === 'development' && token) {
    res.json({ ok: true, devToken: token });
    return;
  }
  res.json({ ok: true });
});

router.post('/password-reset/confirm', async (req, res) => {
  const body = z
    .object({ token: z.string().min(20), newPassword: z.string().min(12) })
    .parse(req.body);
  await confirmPasswordReset(body.token, body.newPassword);
  res.json({ ok: true });
});

// Self-service password change for the signed-in user. Verifies the current
// password (so a stolen session can't silently rewrite credentials), updates
// to the new hash, and revokes all refresh tokens including the current one.
// The frontend redirects to /login after a successful response.
router.post('/change-password', requireAuth, async (req, res) => {
  const body = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(12),
    })
    .parse(req.body);
  await changePassword(req.auth!.userId, body.currentPassword, body.newPassword);
  // Clear the refresh-token cookie since we just revoked it server-side;
  // belt-and-suspenders so the next request doesn't carry a now-invalid token.
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  const hospital = user.hospitalId
    ? await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, user.hospitalId) })
    : null;
  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      hospitalId: user.hospitalId,
    },
    hospital: hospital
      ? { id: hospital.id, name: hospital.name, region: hospital.region }
      : null,
  });
});

export default router;
