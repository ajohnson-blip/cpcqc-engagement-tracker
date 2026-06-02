/**
 * Hospital Readiness Assessment (HRA) business rules.
 *
 * HRAs are required bi-annually for every initiative (TTT, SPARK, SOAR, NEST)
 * and both tracks (active and sustainability) — two per program year. The two
 * HRAs are normally due in Q1 and Q4, but a program year can carry a one-off
 * schedule shift (stored on program_years.hra_schedule). For Program Year 2026
 * only, SPARK's HRAs are due in Q2 and Q4.
 *
 * Kept free of DB/IO imports so the rules can be unit-tested without a database;
 * imports the due-date math from utils/period via a relative path so it resolves
 * under Vitest (which has no `@/` alias).
 */
import {
  computeDueDate,
  computePeriodString,
} from '../../utils/period.js';

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';

/** Two HRAs per program year, every initiative and track. */
export const REQUIRED_ASSESSMENTS_PER_YEAR = 2;

/** Standard HRA due quarters when a program year has no schedule override. */
export const DEFAULT_HRA_QUARTERS: readonly Quarter[] = ['Q1', 'Q4'];

/**
 * Source of truth for per-(initiative, year) HRA schedule overrides. Returns the
 * ordered quarters the HRAs are due in for that program year, or null to use the
 * default. This is the value snapshotted onto program_years.hra_schedule when a
 * program year is created; future one-off shifts are added here as data.
 */
export function hraScheduleOverrideFor(
  initiativeCode: string,
  year: number,
): Quarter[] | null {
  if (initiativeCode === 'SPARK' && year === 2026) return ['Q2', 'Q4'];
  return null;
}

/** Effective HRA quarters for a program year given any stored schedule. */
export function effectiveHraQuarters(
  schedule: readonly string[] | null | undefined,
): readonly Quarter[] {
  if (schedule && schedule.length > 0) return schedule as Quarter[];
  return DEFAULT_HRA_QUARTERS;
}

function defaultQuarterNum(periodLabel: string | null | undefined): number {
  const m = /q([1-4])/i.exec((periodLabel ?? '').trim());
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export interface HraTemplateRef {
  id: string;
  periodLabel: string | null;
}

export interface HraInstanceSchedule {
  templateId: string;
  period: string;
  dueOn: string;
}

/**
 * Computes the concrete period + due date for each HRA task instance of a
 * program year. The HRA templates are ordered by their default quarter and
 * mapped onto the effective quarters in order, so the i-th HRA lands in the
 * i-th scheduled quarter (Q1,Q4 by default; Q2,Q4 for SPARK 2026).
 */
export function scheduleHraInstances(
  hraTemplates: ReadonlyArray<HraTemplateRef>,
  year: number,
  schedule: readonly string[] | null | undefined,
): HraInstanceSchedule[] {
  const quarters = effectiveHraQuarters(schedule);
  const ordered = [...hraTemplates].sort(
    (a, b) => defaultQuarterNum(a.periodLabel) - defaultQuarterNum(b.periodLabel),
  );
  return ordered.map((t, i) => {
    const q = quarters[Math.min(i, quarters.length - 1)]!;
    return {
      templateId: t.id,
      period: computePeriodString('quarterly', q, year),
      dueOn: computeDueDate('quarterly', q, year),
    };
  });
}
