/**
 * The pause switch for REDCap synchronisation.
 *
 * Enforced in two places on purpose: at the route, so the UI gets a clean
 * answer before any work starts, and inside each sync runner, so nothing can
 * reach REDCap by another path. A route-only check has already been a bug in
 * this codebase once — the acceptance endpoint was guarded at the route while
 * the service trusted its caller.
 */
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';

export const SYNC_PAUSED_MESSAGE =
  'REDCap sync is paused. CPCQC has paused all REDCap synchronisation while the ' +
  'data-protection arrangements for the tracker’s hosting environment are finalised. ' +
  'Nothing has been lost and no task data has changed — previously synced months are ' +
  'unaffected and remain visible. Contact the tracker administrator if a month needs ' +
  'updating before syncing resumes.';

export function syncEnabled(): boolean {
  return env.REDCAP_SYNC_ENABLED;
}

/** Throws 503 when syncing is paused. Called by both the routes and the runners. */
export function assertSyncEnabled(): void {
  if (!env.REDCAP_SYNC_ENABLED) throw new HttpError(503, SYNC_PAUSED_MESSAGE);
}
