import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';
import { HttpError } from './errors.js';

export interface AuthContext {
  userId: string;
  role: 'hospital_user' | 'hospital_admin' | 'cpcqc_staff' | 'cpcqc_admin';
  hospitalId: string | null;
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
  return {
    userId: payload.userId,
    role: payload.role,
    hospitalId: payload.hospitalId ?? null,
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
