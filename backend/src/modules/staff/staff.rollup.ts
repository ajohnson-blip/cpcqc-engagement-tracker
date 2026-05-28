/**
 * Shared row-selection rules for the staff dashboards.
 *
 * The /overview rollup and the per-initiative hospital roster must feed the SAME
 * set of enrollments into the compliance engine, otherwise the two pages render
 * different rosters for the same denominator (an at-risk hospital can vanish from
 * the overview while still showing on its initiative page). These helpers are the
 * single source of truth for "which enrollments belong in the rollup", kept free
 * of DB/IO imports so they can be unit-tested without a database.
 */

export type RollupEnrollmentStatus =
  | 'eligible_to_enroll'
  | 'enrolled'
  | 'withdrawn'
  | 'completed';

export interface RollupEnrollment {
  status: RollupEnrollmentStatus;
  /** Drizzle `date` columns come back as ISO strings; Date is accepted too. */
  withdrawnOn: string | Date | null;
}

/** Program years run Jan 1 → Dec 31; this is the start of the year containing asOf. */
function currentProgramYearStart(asOf: Date): number {
  return Date.UTC(asOf.getUTCFullYear(), 0, 1);
}

/**
 * An enrollment is excluded from the rollup only when it is genuinely gone for
 * this program year: status is 'withdrawn' AND it was withdrawn before the
 * current program year began.
 *
 * Withdrawn rows with no withdrawal date (data drift) are intentionally kept so
 * the compliance engine's verdict — not a missing date — drives the dashboard.
 */
export function isExcludedFromRollup(
  enrollment: RollupEnrollment,
  asOf: Date = new Date(),
): boolean {
  if (enrollment.status !== 'withdrawn') return false;
  if (enrollment.withdrawnOn == null) return false;
  const withdrawnAt =
    enrollment.withdrawnOn instanceof Date
      ? enrollment.withdrawnOn.getTime()
      : Date.parse(enrollment.withdrawnOn);
  if (Number.isNaN(withdrawnAt)) return false;
  return withdrawnAt < currentProgramYearStart(asOf);
}

/** Enrollments the /overview rollup counts. */
export function selectOverviewRollup<T extends RollupEnrollment>(
  enrollments: T[],
  asOf: Date = new Date(),
): T[] {
  return enrollments.filter((e) => !isExcludedFromRollup(e, asOf));
}

/** Enrollments the /initiatives/:code/hospitals roster renders. */
export function selectInitiativeHospitals<T extends RollupEnrollment>(
  enrollments: T[],
  includeWithdrawn: boolean,
  asOf: Date = new Date(),
): T[] {
  if (includeWithdrawn) return enrollments;
  return enrollments.filter((e) => !isExcludedFromRollup(e, asOf));
}
