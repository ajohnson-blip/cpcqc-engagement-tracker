import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';
import { HttpError } from './errors.js';

export interface AuthContext {
  userId: string;
  role: 'hospital_user' | 'hospital_admin' | 'cpcqc_staff' | 'cpcqc_admin';
  /** Primary/default hospital (back-compat; also the default "active" one). */
  hospitalId: string | null;
  /**
   * Full set of hospitals this user may access — the primary plus any granted
   * via user_hospitals (regional staff). Always includes hospitalId when
   * non-null. Single-hospital users have exactly [hospitalId], so
   * `hospitalIds.includes(x)` behaves like the old `hospitalId === x`.
   */
  hospitalIds: string[];
}

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Request {
    auth?: AuthContext;
  }
}

export function signAccessToken(ctx: AuthContext): string {
  return jwt.sign(ctx, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AuthContext {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & AuthContext;
  const hospitalId = payload.hospitalId ?? null;
  // Back-compat: tokens issued before multi-hospital won't carry hospitalIds;
  // fall back to [primary] so old sessions keep working until they refresh.
  const hospitalIds = Array.isArray(payload.hospitalIds)
    ? payload.hospitalIds
    : hospitalId
      ? [hospitalId]
      : [];
  return {
    userId: payload.userId,
    role: payload.role,
    hospitalId,
    hospitalIds,
  };
}

export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) throw new HttpError(401, 'Missing access token');
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch {
    throw new HttpError(401, 'Invalid or expired access token');
  }
};

export const requireRole =
  (...roles: AuthContext['role'][]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) throw new HttpError(401, 'Not authenticated');
    if (!roles.includes(req.auth.role)) throw new HttpError(403, 'Forbidden');
    next();
  };

export const requireStaff = requireRole('cpcqc_staff', 'cpcqc_admin');
export const requireAdmin = requireRole('cpcqc_admin');

/**
 * Resolve which hospital a hospital-user request is acting on. A regional user
 * can pass the active hospital (e.g. from the portal switcher); it must be one
 * they're allowed to access. With no explicit choice, defaults to their
 * primary, then the first accessible. Throws 403 for an inaccessible request
 * and 400 when the account has no hospital at all.
 */
export function resolveActiveHospitalId(
  ctx: AuthContext,
  requested?: string | null,
): string {
  if (requested) {
    if (!ctx.hospitalIds.includes(requested)) {
      throw new HttpError(403, 'You do not have access to that hospital.');
    }
    return requested;
  }
  if (ctx.hospitalId) return ctx.hospitalId;
  if (ctx.hospitalIds.length > 0) return ctx.hospitalIds[0]!;
  throw new HttpError(400, 'No hospital is associated with this account.');
}
