/**
 * Period and due-date utilities for task instances.
 *
 * A TaskTemplate defines:
 *  - period: 'once' | 'annual' | 'quarterly' | 'monthly'
 *  - periodLabel: 'Annual' | 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'January' | 'February' | ...
 *
 * When generating a TaskInstance for a given program year, we produce a concrete
 * period string like '2026-Q1' or '2026-03' or '2026-annual', plus an inferred
 * due date (end of period unless template overrides).
 */

export type TemplatePeriod = 'once' | 'annual' | 'quarterly' | 'monthly';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

const QUARTERS = {
  q1: { num: 1, endMonth: 3, endDay: 31 },
  q2: { num: 2, endMonth: 6, endDay: 30 },
  q3: { num: 3, endMonth: 9, endDay: 30 },
  q4: { num: 4, endMonth: 12, endDay: 31 },
} as const;

const MONTH_END_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthEndDay(year: number, monthIndex: number): number {
  if (monthIndex === 1 && isLeapYear(year)) return 29; // Feb leap year
  return MONTH_END_DAYS[monthIndex]!;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Returns the concrete period string for a task instance, e.g. '2026-Q1' or '2026-03'. */
export function computePeriodString(
  templatePeriod: TemplatePeriod,
  periodLabel: string | null | undefined,
  year: number,
): string {
  const label = (periodLabel ?? '').trim().toLowerCase();
  switch (templatePeriod) {
    case 'once':
    case 'annual':
      return `${year}-annual`;
    case 'quarterly': {
      const q = label.replace(/[^a-z0-9]/g, '');
      if (q in QUARTERS) return `${year}-${q.toUpperCase()}`;
      throw new Error(`Unrecognized quarterly periodLabel "${periodLabel}"`);
    }
    case 'monthly': {
      const idx = MONTHS.indexOf(label as (typeof MONTHS)[number]);
      if (idx < 0) throw new Error(`Unrecognized monthly periodLabel "${periodLabel}"`);
      return `${year}-${pad2(idx + 1)}`;
    }
    default:
      throw new Error(`Unknown templatePeriod "${templatePeriod}"`);
  }
}

/**
 * Computes the inferred due date for a task instance as the last day of the period.
 * Templates can override via a textual rule (`dueDateRule`); for now we return the
 * structural default and leave override parsing as future work.
 *
 * Returns an ISO date string (YYYY-MM-DD), matching Drizzle's `date` column.
 */
export function computeDueDate(
  templatePeriod: TemplatePeriod,
  periodLabel: string | null | undefined,
  year: number,
): string {
  const label = (periodLabel ?? '').trim().toLowerCase();
  switch (templatePeriod) {
    case 'once':
    case 'annual':
      return `${year}-12-31`;
    case 'quarterly': {
      const q = label.replace(/[^a-z0-9]/g, '');
      const def = (QUARTERS as Record<string, { endMonth: number; endDay: number }>)[q];
      if (!def) throw new Error(`Unrecognized quarterly periodLabel "${periodLabel}"`);
      return `${year}-${pad2(def.endMonth)}-${pad2(def.endDay)}`;
    }
    case 'monthly': {
      const idx = MONTHS.indexOf(label as (typeof MONTHS)[number]);
      if (idx < 0) throw new Error(`Unrecognized monthly periodLabel "${periodLabel}"`);
      return `${year}-${pad2(idx + 1)}-${pad2(monthEndDay(year, idx))}`;
    }
    default:
      throw new Error(`Unknown templatePeriod "${templatePeriod}"`);
  }
}

/** Quarter number (1-4) of a given date — useful for compliance evaluators. */
export function quarterOf(date: Date): 1 | 2 | 3 | 4 {
  const m = date.getUTCMonth() + 1;
  if (m <= 3) return 1;
  if (m <= 6) return 2;
  if (m <= 9) return 3;
  return 4;
}
