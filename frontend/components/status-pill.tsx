import clsx from 'clsx';
import type { RequirementStatus, TaskStatus } from '@/lib/types';

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
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
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
