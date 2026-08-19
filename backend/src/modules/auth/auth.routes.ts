import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, frontendBaseUrl } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { requireAuth } from '@/middleware/auth.js';
import { db, schema } from '@/db/index.js';
import { eq, inArray } from 'drizzle-orm';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import { passwordResetEmail } from '@/modules/notifications/templates.js';
import {
  changePassword,
  login,
  logout,
  refresh,
  requestPasswordReset,
  confirmPasswordReset,
  PASSWORD_RESET_TTL_MINUTES,
} from './auth.service.js';

const router = Router();

const REFRESH_COOKIE = 'cpcqc_refresh';

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // The frontend (qi.cpcqc.org) and the API (*.onrender.com) are different
    // SITES, so a Lax cookie is never sent on the refresh call — the session
    // silently failed to persist across reloads. 'none' is only legal on a
    // Secure cookie, hence keying off COOKIE_SECURE: production gets 'none',
    // local dev stays 'lax' (where it's same-origin anyway and Secure is off).
    sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
    // Only ever set a domain we actually own. Pointing this at another host —
    // as the deployed config did — makes the browser reject the cookie
    // outright. Blank means host-only, which is the right default.
    domain: env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? env.COOKIE_DOMAIN : undefined,
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
  res.clearCookie(REFRESH_COOKIE, {
    path: '/',
    sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? env.COOKIE_DOMAIN : undefined,
  });
  res.status(204).end();
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new HttpError(401, 'Missing refresh token');
  const result = await refresh(token);
  setRefreshCookie(res, result.refreshToken);
  res.json({ accessToken: result.accessToken, user: result.auth });
});

/**
 * Tighter limit than the /auth default: each request sends real email, and on
 * SendGrid's lower tiers a scripted loop could burn the whole daily quota and
 * take invites and certificate sends down with it.
 */
const resetRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many password reset requests. Please try again later.' },
});

router.post('/password-reset/request', resetRequestLimiter, async (req, res) => {
  const body = z.object({ email: z.string().email() }).parse(req.body);
  const result = await requestPasswordReset(body.email);

  if (result) {
    const resetUrl = `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(result.token)}`;
    const { subject, body: text } = passwordResetEmail({
      recipientName: result.user.firstName ?? 'there',
      resetUrl,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
    });
    // Failures are logged by sendEmail and must not change the response —
    // a different reply for a failed send would leak that the account exists.
    await sendEmail({
      toEmail: result.user.email,
      subject,
      body: text,
      kind: 'password_reset',
      userId: result.user.id,
    });
  }

  // Dev convenience: return the token so a local reset doesn't need a mailbox.
  if (env.NODE_ENV === 'development' && result) {
    res.json({ ok: true, devToken: result.token });
    return;
  }
  // Always the same shape, whether or not the address matched an account.
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
  res.clearCookie(REFRESH_COOKIE, {
    path: '/',
    sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? env.COOKIE_DOMAIN : undefined,
  });
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const userId = req.auth!.userId;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  const hospital = user.hospitalId
    ? await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, user.hospitalId) })
    : null;

  // Full accessible-hospital set (primary ∪ user_hospitals grants), so the
  // portal can render a switcher for regional staff. The auth context already
  // carries the ids; resolve them to names here.
  const accessibleIds = req.auth!.hospitalIds;
  const hospitals = accessibleIds.length
    ? (
        await db
          .select({ id: schema.hospitals.id, name: schema.hospitals.name })
          .from(schema.hospitals)
          .where(inArray(schema.hospitals.id, accessibleIds))
      ).sort((a, b) => a.name.localeCompare(b.name))
    : [];

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
    hospitals,
  });
});

export default router;
