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
  return env.SYNC_ENABLED;
}

/** Throws 503 when syncing is paused. Called by both the routes and the runners. */
export function assertSyncEnabled(): void {
  if (!env.SYNC_ENABLED) throw new HttpError(503, SYNC_PAUSED_MESSAGE);
}

/**
 * For a program whose sync can only query REDCap directly, on a deployment
 * that reads CHA's assessment file instead (SYNC_SOURCE=cha). That deployment
 * holds no REDCap tokens by design, so refuse plainly — the alternative is a
 * "token not configured" error, which invites someone to add one.
 *
 * Call it before any token check. Remove a program's call once its sync can
 * read CHA's file.
 */
export function assertRedcapSource(program: string): void {
  if (env.SYNC_SOURCE === 'cha') {
    throw new HttpError(
      409,
      `${program} isn't available from CHA's assessment file yet. This deployment reads CHA's file and never ` +
        `queries REDCap, so ${program} will sync here once CHA's script covers it.`,
    );
  }
}
