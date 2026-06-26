/**
 * Human-in-the-loop overrides for the REDCap syncs (SPARK + NEST).
 *
 * The sync computes a status for every hospital-period from REDCap. In the
 * preview, a program manager can OVERRIDE that status (using judgment) and
 * record a rationale ("Comments"). On apply, the chosen disposition is written
 * instead of the computed one. Both data-submission programs share one set of
 * dispositions, each mapping to a concrete (status, outcome) on the task.
 */

export type TaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
export type TaskOutcome = 'on_time' | 'late' | 'attended' | 'missed' | 'not_submitted' | null;

export type SyncDisposition = 'counts' | 'late' | 'incomplete' | 'not_submitted' | 'pending';

export const SYNC_DISPOSITIONS: ReadonlyArray<{ value: SyncDisposition; label: string }> = [
  { value: 'counts', label: 'Counts (complete & on time)' },
  { value: 'late', label: 'Late (complete, past deadline)' },
  { value: 'incomplete', label: 'Incomplete (needs revision)' },
  { value: 'not_submitted', label: 'Not submitted' },
  { value: 'pending', label: 'Pending (not yet due)' },
];

/** What writing a chosen disposition does to the task instance. */
export function dispositionToTask(
  d: SyncDisposition,
  submissionDate: string | null,
  today: string,
): { status: TaskStatus; outcome: TaskOutcome; completedOn: string | null } {
  switch (d) {
    case 'counts':
      return { status: 'complete', outcome: 'on_time', completedOn: submissionDate ?? today };
    case 'late':
      return { status: 'complete', outcome: 'late', completedOn: submissionDate ?? today };
    case 'incomplete':
      return { status: 'needs_revision', outcome: null, completedOn: null };
    case 'not_submitted':
      return { status: 'complete', outcome: 'not_submitted', completedOn: null };
    case 'pending':
      return { status: 'not_started', outcome: null, completedOn: null };
  }
}

/** Computed sync category → the disposition the dropdown defaults to. */
export function categoryToDisposition(category: string): SyncDisposition {
  switch (category) {
    case 'counting':
    case 'complete_nodate':
      return 'counts';
    case 'complete_late':
      return 'late';
    case 'incomplete':
      return 'incomplete';
    case 'not_submitted':
      return 'not_submitted';
    default:
      return 'pending';
  }
}

export interface SyncOverride {
  disposition: SyncDisposition;
  comment: string;
}
