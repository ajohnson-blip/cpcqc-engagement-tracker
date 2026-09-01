import clsx from 'clsx';
import type { RequirementStatus, TaskStatus, TaskOutcome, TaskType } from '@/lib/types';

const REQ_STATUS_STYLES: Record<RequirementStatus, { bg: string; fg: string; label: string }> = {
  met: { bg: 'bg-cpcqc-teal-dark', fg: 'text-white', label: 'Met' },
  on_track: { bg: 'bg-cpcqc-purple', fg: 'text-white', label: 'On track' },
  at_risk: { bg: 'bg-cpcqc-orange-dark', fg: 'text-white', label: 'At risk' },
  not_met: { bg: 'bg-cpcqc-pink-dark', fg: 'text-white', label: 'Not met' },
};

const TASK_STATUS_STYLES: Record<TaskStatus, { bg: string; fg: string; label: string }> = {
  not_started: { bg: 'bg-cpcqc-purple-dark/10', fg: 'text-cpcqc-purple-dark', label: 'Not started' },
  current_activities: { bg: 'bg-cpcqc-purple/15', fg: 'text-cpcqc-purple', label: 'In progress' },
  complete: { bg: 'bg-cpcqc-teal-dark/15', fg: 'text-cpcqc-teal-dark', label: 'Complete' },
  needs_revision: {
    bg: 'bg-cpcqc-pink-dark/15',
    fg: 'text-cpcqc-pink-dark',
    label: 'Needs revision',
  },
};

export function RequirementStatusPill({
  status,
  className,
}: {
  status: RequirementStatus;
  className?: string;
}) {
  const { bg, fg, label } = REQ_STATUS_STYLES[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide',
        bg,
        fg,
        className,
      )}
    >
      {label}
    </span>
  );
}

export function TaskStatusPill({
  status,
  outcome,
  taskType,
  className,
}: {
  status: TaskStatus;
  outcome?: TaskOutcome;
  /** Data submissions say "Incomplete" rather than "Needs revision" — see below. */
  taskType?: TaskType;
  className?: string;
}) {
  // A data submission judged incomplete is a closed verdict, not an open
  // action. The REDCap sync's own dropdown calls it "Incomplete", so a PM
  // picked that word and the hospital was shown "Needs revision" — which reads
  // as "go fix this", and reads worse once the month is locked and they can't.
  // Elsewhere (advising, meetings, HRA) "Needs revision" is exactly right and
  // is left alone.
  if (status === 'needs_revision' && taskType === 'data_submission') {
    return (
      <span
        className={clsx(
          'inline-flex items-center rounded-full bg-cpcqc-pink-dark/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-pink-dark',
          className,
        )}
        title="Submitted but incomplete — does not count toward compliance"
      >
        Incomplete
      </span>
    );
  }
  // When the task is complete but the outcome was 'late' or 'missed', show
  // a distinct pill — these were recorded but do not count toward compliance.
  if (status === 'complete' && outcome === 'late') {
    return (
      <span
        className={clsx(
          'inline-flex items-center rounded-full bg-cpcqc-orange-dark/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-orange-dark',
          className,
        )}
        title="Submitted late — recorded but does not count toward compliance"
      >
        Late
      </span>
    );
  }
  if (status === 'complete' && outcome === 'missed') {
    return (
      <span
        className={clsx(
          'inline-flex items-center rounded-full bg-cpcqc-pink-dark/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-pink-dark',
          className,
        )}
        title="Did not attend — recorded but does not count toward compliance"
      >
        Missed
      </span>
    );
  }
  if (status === 'complete' && outcome === 'not_submitted') {
    return (
      <span
        className={clsx(
          'inline-flex items-center rounded-full bg-cpcqc-pink-dark/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-pink-dark',
          className,
        )}
        title="Not submitted — recorded but does not count toward compliance"
      >
        Not submitted
      </span>
    );
  }
  const { bg, fg, label } = TASK_STATUS_STYLES[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide',
        bg,
        fg,
        className,
      )}
    >
      {label}
    </span>
  );
}
