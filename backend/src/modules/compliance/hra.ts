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
import type { RequirementResult } from './compliance.service.js';

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

function quarterToNum(q: string): 1 | 2 | 3 | 4 | null {
  if (q === 'Q1') return 1;
  if (q === 'Q2') return 2;
  if (q === 'Q3') return 3;
  if (q === 'Q4') return 4;
  return null;
}

/** Last instant of the named quarter's end day, in UTC milliseconds. */
function quarterEndMs(year: number, quarter: 1 | 2 | 3 | 4): number {
  // Start of the month AFTER the quarter ends, minus 1 ms.
  const startNextQuarter = [
    Date.UTC(year, 3, 1), // Q1 → April 1
    Date.UTC(year, 6, 1), // Q2 → July 1
    Date.UTC(year, 9, 1), // Q3 → October 1
    Date.UTC(year + 1, 0, 1), // Q4 → next January 1
  ];
  return startNextQuarter[quarter - 1]! - 1;
}

/**
 * Generic milestone-schedule evaluator. Each entry in `quarters` is a hard
 * deadline. As `asOf` passes each quarter's end the "expected" count grows;
 * `completed` is compared to expected (at_risk if short) and to required
 * (met if all done, not_met if year-ended with shortfall).
 *
 * Used for HRAs (via evaluateHraSchedule below) and for QI advising sessions
 * (see compliance.service — advising is "once per quarter" for active tracks).
 */
export function evaluateQuarterlyMilestones(
  quarters: readonly string[],
  completed: number,
  programYear: number,
  asOf: Date,
  options: { itemLabel: string; itemLabelPlural: string },
): RequirementResult {
  const required = quarters.length;
  const nowMs = asOf.getTime();
  let expected = 0;
  for (const q of quarters) {
    const qn = quarterToNum(q);
    if (qn == null) continue; // skip unrecognized labels rather than crash
    if (quarterEndMs(programYear, qn) < nowMs) expected += 1;
  }
  const yearEnded = expected === required;

  if (completed >= required) {
    return { status: 'met', current: completed, required, expected: required };
  }
  if (yearEnded) {
    return {
      status: 'not_met',
      current: completed,
      required,
      expected: required,
      reason: `Year ended with ${completed} of ${required} ${options.itemLabelPlural} complete.`,
    };
  }
  if (completed < expected) {
    return {
      status: 'at_risk',
      current: completed,
      required,
      expected,
      reason: `${expected} ${options.itemLabel} deadline(s) have passed; ${completed} complete.`,
    };
  }
  return { status: 'on_track', current: completed, required, expected };
}

/**
 * Monthly "min N of M" milestone evaluator. The active cohort rule for both
 * meetings and data submissions is "complete at least N of 12 months" — so
 * the hospital can be missing up to (totalPeriods - minRequired) months
 * without falling behind. Expected = max(0, monthsEnded - skipAllowance),
 * so a 9-of-12 hospital is on_track at 0 done through end of March (months
 * 1, 2, 3 are within the skip allowance) and only flips to at_risk if
 * they're behind starting from month 4.
 */
export function evaluateMonthlyMilestones(
  totalPeriods: number,
  minRequired: number,
  completed: number,
  programYear: number,
  asOf: Date,
  options: { itemLabel: string; itemLabelPlural: string },
): RequirementResult {
  let monthsEnded = 0;
  for (let m = 0; m < 12; m++) {
    const monthEndMs = Date.UTC(programYear, m + 1, 1) - 1;
    if (monthEndMs < asOf.getTime()) monthsEnded += 1;
  }
  const skipAllowance = Math.max(0, totalPeriods - minRequired);
  const expected = Math.max(0, Math.min(minRequired, monthsEnded - skipAllowance));
  const yearEnded = monthsEnded === 12;

  if (completed >= minRequired) {
    return { status: 'met', current: completed, required: minRequired, expected: minRequired };
  }
  if (yearEnded) {
    return {
      status: 'not_met',
      current: completed,
      required: minRequired,
      expected: minRequired,
      reason: `Year ended with ${completed} of ${minRequired} ${options.itemLabelPlural} complete.`,
    };
  }
  if (completed < expected) {
    return {
      status: 'at_risk',
      current: completed,
      required: minRequired,
      expected,
      reason: `${expected} ${options.itemLabelPlural} expected by now; ${completed} complete.`,
    };
  }
  return { status: 'on_track', current: completed, required: minRequired, expected };
}

/**
 * Evaluates HRA compliance as a milestone schedule rather than an annual
 * threshold. Standard Q1+Q4 (or SPARK 2026's Q2+Q4); the engine flags at_risk
 * the moment a scheduled quarter's deadline passes without a completion.
 *
 * Replaces the previous threshold-based assessments verdict, which silently
 * tolerated a missed Q1 HRA until July (yearFraction >= 0.5).
 */
export function evaluateHraSchedule(
  schedule: readonly string[] | null | undefined,
  completed: number,
  programYear: number,
  asOf: Date,
): RequirementResult {
  return evaluateQuarterlyMilestones(
    effectiveHraQuarters(schedule),
    completed,
    programYear,
    asOf,
    { itemLabel: 'HRA', itemLabelPlural: 'HRAs' },
  );
}
