import { describe, expect, it } from 'vitest';
import {
  isExcludedFromRollup,
  selectInitiativeHospitals,
  selectOverviewRollup,
  type RollupEnrollmentStatus,
} from './staff.rollup.js';
import {
  evaluateProgramYear,
  type ProgramYearProgress,
  type ProgramYearThresholds,
  type RequirementStatus,
} from '../compliance/compliance.service.js';

// 2026-05-28 → yearFraction ≈ 0.41. Below the 0.5 threshold, so the compliance
// engine's only source of at_risk is the enrollment-status branch — exactly the
// regime the dashboards are in today.
const ASOF = new Date('2026-05-28T12:00:00Z');
const PROGRAM_YEAR = 2026;

const activeThresholds: ProgramYearThresholds = {
  requiredMeetings: 9,
  requiredAdvising: 4,
  requiredDataPeriods: 12,
  dataSubmissionsMin: 12,
  requiredAssessments: 0,
};

interface Fixture {
  id: string;
  status: RollupEnrollmentStatus;
  withdrawnOn: string | null;
  overall: RequirementStatus;
}

// Build a fixture by running it through the SAME compliance engine both
// dashboards use, with zero task progress. This is what makes the test
// meaningful: the engine is identical across paths, so any disagreement in the
// at-risk count can only come from which rows each path feeds in.
function makeFixture(
  id: string,
  status: ProgramYearProgress['enrollmentStatus'],
  withdrawnOn: string | null,
): Fixture {
  const result = evaluateProgramYear(
    activeThresholds,
    {
      meetingsAttended: 0,
      advisingCompleted: 0,
      dataSubmissionsCompleted: 0,
      assessmentsCompleted: 0,
      enrollmentStatus: status,
    },
    { programYear: PROGRAM_YEAR, asOf: ASOF },
  );
  return { id, status, withdrawnOn, overall: result.overall };
}

const enrollments: Fixture[] = [
  makeFixture('active', 'enrolled', null), // healthy, on_track
  makeFixture('withdrawn-prior-year', 'withdrawn', '2025-06-01'), // gone before PY 2026
  makeFixture('withdrawn-data-drift', 'withdrawn', null), // status drift, no date
];

describe('isExcludedFromRollup', () => {
  it('keeps active enrollments', () => {
    expect(isExcludedFromRollup({ status: 'enrolled', withdrawnOn: null }, ASOF)).toBe(false);
  });

  it('excludes a withdrawal dated before the current program year', () => {
    expect(isExcludedFromRollup({ status: 'withdrawn', withdrawnOn: '2025-06-01' }, ASOF)).toBe(true);
  });

  it('keeps a withdrawal dated inside the current program year', () => {
    expect(isExcludedFromRollup({ status: 'withdrawn', withdrawnOn: '2026-03-01' }, ASOF)).toBe(false);
  });

  it('keeps a withdrawn row with no withdrawal date (data drift)', () => {
    expect(isExcludedFromRollup({ status: 'withdrawn', withdrawnOn: null }, ASOF)).toBe(false);
  });
});

describe('staff overview rollup vs initiative roster', () => {
  it('the fixtures exercise only the enrollment-status at_risk branch', () => {
    const byId = new Map(enrollments.map((e) => [e.id, e.overall]));
    expect(byId.get('active')).toBe('on_track');
    expect(byId.get('withdrawn-prior-year')).toBe('at_risk');
    expect(byId.get('withdrawn-data-drift')).toBe('at_risk');
  });

  it('overview rollup and initiative roster report the same at-risk count', () => {
    const overviewAtRisk = selectOverviewRollup(enrollments, ASOF).filter(
      (e) => e.overall === 'at_risk',
    ).length;

    const initiativeAtRisk = selectInitiativeHospitals(enrollments, false, ASOF).filter(
      (e) => e.overall === 'at_risk',
    ).length;

    // The crux: the two dashboards must agree. Before the fix, /overview filtered
    // on withdrawnOn IS NULL (counting the data-drift row but not the prior-year
    // one) while the roster counted both → 1 vs 2.
    expect(overviewAtRisk).toBe(initiativeAtRisk);
    // The prior-year withdrawal drops from both; the data-drift row stays in both.
    expect(overviewAtRisk).toBe(1);
  });

  it('includeWithdrawn=true reveals the prior-year withdrawal in the roster only', () => {
    expect(selectInitiativeHospitals(enrollments, true, ASOF)).toHaveLength(3);
    expect(selectInitiativeHospitals(enrollments, false, ASOF)).toHaveLength(2);
    expect(selectOverviewRollup(enrollments, ASOF)).toHaveLength(2);
  });
});
