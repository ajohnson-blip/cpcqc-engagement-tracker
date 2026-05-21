import { format, parseISO, isValid } from 'date-fns';
import type { TaskType } from './types';

export function fmtDate(iso: string | null | undefined, dateFormat = 'MMM d, yyyy'): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? parseISO(iso) : iso;
  if (!isValid(d)) return iso ?? '—';
  return format(d, dateFormat);
}

export function fmtPeriod(period: string): string {
  // "2026-Q1" → "Q1 2026"; "2026-03" → "Mar 2026"; "2026-annual" → "Annual 2026"
  const m = /^(\d{4})-(.+)$/.exec(period);
  if (!m) return period;
  const [, year, rest] = m;
  if (rest === 'annual') return `Annual ${year}`;
  if (/^Q[1-4]$/.test(rest!)) return `${rest} ${year}`;
  if (/^\d{2}$/.test(rest!)) {
    const monthNum = parseInt(rest!, 10);
    const monthName = format(new Date(2000, monthNum - 1, 1), 'MMM');
    return `${monthName} ${year}`;
  }
  return period;
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  enrollment_form: 'Enrollment Form',
  meeting_attendance: 'Meeting attendance',
  qi_advising: 'QI advising session',
  data_submission: 'Data submission',
  readiness_assessment: 'Readiness assessment',
  other: 'Other',
};
