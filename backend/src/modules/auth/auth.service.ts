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

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await db.query.users.findFirst({
    where: and(sql`lower(${schema.users.email}) = lower(${email})`, isNull(schema.users.deactivatedAt)),
  });
  if (!user) throw new HttpError(401, 'Invalid credentials');
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Invalid credentials');

  const auth: AuthContext = {
    userId: user.id,
    role: user.role,
    hospitalId: user.hospitalId ?? null,
  };

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

  const auth: AuthContext = {
    userId: user.id,
    role: user.role,
    hospitalId: user.hospitalId ?? null,
  };
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

export async function requestPasswordReset(email: string): Promise<string | null> {
  const user = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${email})`,
  });
  if (!user) return null; // do not reveal whether the email exists
  const { token, hash } = newOpaqueToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await db.insert(schema.passwordResets).values({
    id: uuid(),
    userId: user.id,
    tokenHash: hash,
    expiresAt,
  });
  return token;
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
