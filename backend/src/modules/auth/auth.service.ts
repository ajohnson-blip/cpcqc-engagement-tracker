import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { signAccessToken, type AuthContext } from '@/middleware/auth.js';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Unambiguous charset (no 0/O/1/l/I) so a temp password survives being read
// off a screen or copied from the staff UI. 16 chars ≈ 94 bits of entropy,
// comfortably over the 12-char minimum the login/change-password flows enforce.
const TEMP_PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function generateTempPassword(len = 16): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += TEMP_PW_CHARS[bytes[i]! % TEMP_PW_CHARS.length];
  return out;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newOpaqueToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(40).toString('base64url');
  return { token, hash: hashToken(token) };
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  auth: AuthContext;
}

/**
 * Build the auth context for a user, including the full accessible-hospital
 * set (primary users.hospital_id ∪ user_hospitals grants). Baked into the
 * access token, so a grant/revoke takes effect on the user's next token
 * refresh (≤ access TTL) or immediately on re-login.
 */
async function buildAuthContext(user: {
  id: string;
  role: AuthContext['role'];
  hospitalId: string | null;
}): Promise<AuthContext> {
  const ids = new Set<string>();
  if (user.hospitalId) ids.add(user.hospitalId);
  if (user.role === 'hospital_user' || user.role === 'hospital_admin') {
    const extra = await db
      .select({ hospitalId: schema.userHospitals.hospitalId })
      .from(schema.userHospitals)
      .where(eq(schema.userHospitals.userId, user.id));
    for (const e of extra) ids.add(e.hospitalId);
  }
  return {
    userId: user.id,
    role: user.role,
    hospitalId: user.hospitalId ?? null,
    hospitalIds: Array.from(ids),
  };
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await db.query.users.findFirst({
    where: and(sql`lower(${schema.users.email}) = lower(${email})`, isNull(schema.users.deactivatedAt)),
  });
  if (!user) throw new HttpError(401, 'Invalid credentials');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Invalid credentials');

  const auth = await buildAuthContext(user);

  const accessToken = signAccessToken(auth);
  const { token: refreshToken, hash: tokenHash } = newOpaqueToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(schema.refreshTokens).values({
    id: uuid(),
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  await db
    .update(schema.users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.users.id, user.id));

  return { accessToken, refreshToken, auth };
}

export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.refreshTokens.tokenHash, tokenHash));
}

export async function refresh(refreshToken: string): Promise<LoginResult> {
  const tokenHash = hashToken(refreshToken);
  const row = await db.query.refreshTokens.findFirst({
    where: and(eq(schema.refreshTokens.tokenHash, tokenHash), isNull(schema.refreshTokens.revokedAt)),
  });
  if (!row || row.expiresAt < new Date()) throw new HttpError(401, 'Invalid refresh token');

  const user = await db.query.users.findFirst({ where: eq(schema.users.id, row.userId) });
  if (!user || user.deactivatedAt) throw new HttpError(401, 'User no longer active');

  // Rotate refresh token
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.refreshTokens.id, row.id));

  const auth = await buildAuthContext(user);
  const accessToken = signAccessToken(auth);
  const { token: newRefresh, hash: newHash } = newOpaqueToken();
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(schema.refreshTokens).values({
    id: uuid(),
    userId: user.id,
    tokenHash: newHash,
    expiresAt,
  });
  return { accessToken, refreshToken: newRefresh, auth };
}

/** How long a reset link stays valid. Surfaced in the email so the wording and
 *  the actual expiry can't drift apart. */
export const PASSWORD_RESET_TTL_MINUTES = 60;

export interface PasswordResetRequest {
  token: string;
  /** Needed to address the email. Callers must NOT echo any of this back in the
   *  HTTP response — the endpoint has to look identical for unknown addresses. */
  user: { id: string; email: string; firstName: string | null };
}

export async function requestPasswordReset(email: string): Promise<PasswordResetRequest | null> {
  const user = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${email})`,
  });
  if (!user) return null; // do not reveal whether the email exists
  if (user.deactivatedAt) return null; // deactivated accounts can't be reset back into
  const { token, hash } = newOpaqueToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
  await db.insert(schema.passwordResets).values({
    id: uuid(),
    userId: user.id,
    tokenHash: hash,
    expiresAt,
  });
  return { token, user: { id: user.id, email: user.email, firstName: user.firstName ?? null } };
}

/**
 * Self-service password change. Requires the signed-in user's current password
 * as proof of identity (so a stolen session cookie can't silently rewrite
 * credentials) and validates the new password length.
 *
 * On success, revokes every refresh token for the user — including the one
 * powering the current session. Same pattern as confirmPasswordReset: if the
 * credentials just changed, everywhere they were signed in needs to re-auth.
 * The frontend redirects to /login after the call returns.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 12) {
    throw new HttpError(400, 'New password must be at least 12 characters.');
  }
  if (currentPassword === newPassword) {
    throw new HttpError(400, 'New password must be different from the current one.');
  }
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw new HttpError(400, 'Current password is incorrect.');
  const hash = await hashPassword(newPassword);
  await db
    .update(schema.users)
    .set({ passwordHash: hash, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  // Revoke ALL refresh tokens for this user — including the one powering the
  // current session. The frontend redirects to /login immediately after a
  // successful change so the user reauthenticates with the new password.
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)));
}

export async function confirmPasswordReset(token: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(token);
  const row = await db.query.passwordResets.findFirst({
    where: and(eq(schema.passwordResets.tokenHash, tokenHash), isNull(schema.passwordResets.usedAt)),
  });
  if (!row || row.expiresAt < new Date()) throw new HttpError(400, 'Invalid or expired reset token');
  const hash = await hashPassword(newPassword);
  await db
    .update(schema.users)
    .set({ passwordHash: hash, updatedAt: new Date() })
    .where(eq(schema.users.id, row.userId));
  await db
    .update(schema.passwordResets)
    .set({ usedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.passwordResets.id, row.id));
  // Revoke all refresh tokens for safety
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.refreshTokens.userId, row.userId), isNull(schema.refreshTokens.revokedAt)));
}
