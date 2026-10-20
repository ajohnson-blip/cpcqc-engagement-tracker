/**
 * POST /integrations/cha/assessment-files
 *
 * Where CHA's nightly assessment script delivers its file
 * (docs/cha-sync-contract.md, "Delivery"). Server to server: no session, no
 * CORS, authenticated by the bearer token shared with CHA.
 *
 *   200 { status: "stored" | "already_stored", snapshot_id }
 *   400 the file was refused; nothing was stored. The message says why.
 *   401 missing or wrong token
 *   409 this snapshot id was already received with different content
 *   503 this deployment does not receive files (no token configured)
 *
 * Mounted ahead of the global JSON parser, which is capped at 1 MB: a file
 * covering every program, and two program years in January and February, can
 * approach that. The raw bytes are also what the stored hash is taken over.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { storeSnapshot } from './cha-snapshot.service.js';

export const CHA_INGEST_PATH = '/integrations/cha/assessment-files';

// Below this, a token is too guessable to guard the endpoint at all.
const MIN_TOKEN_LENGTH = 32;
const MAX_FILE_SIZE = '10mb';

function sameToken(presented: string, expected: string): boolean {
  // Hashed first so the comparison is constant-time whatever the lengths.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Fails closed. A deployment receives files only once a strong token is set,
 * and the check runs before the body is read, so an unauthenticated caller
 * never gets a 10 MB parse.
 */
const requireChaToken: RequestHandler = (req, _res, next) => {
  const expected = env.CHA_ASSESSMENT_TOKEN ?? '';
  if (expected.length < MIN_TOKEN_LENGTH) {
    next(new HttpError(503, 'This deployment is not configured to receive assessment files.'));
    return;
  }
  const m = /^Bearer\s+(\S+)$/.exec(req.get('authorization') ?? '');
  if (!m || !sameToken(m[1]!, expected)) {
    next(new HttpError(401, 'Missing or invalid token.'));
    return;
  }
  next();
};

// One delivery a night, a few retries, the odd hand-started run.
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.post(
  '/',
  limiter,
  requireChaToken,
  express.raw({ type: 'application/json', limit: MAX_FILE_SIZE }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(400, 'Expected the file as the request body, with Content-Type: application/json.');
    }
    const result = await storeSnapshot(req.body);
    res.status(200).json({ status: result.status, snapshot_id: result.snapshotId });
  },
);

export default router;
