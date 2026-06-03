import { describe, expect, it } from 'vitest';
import {
  dedupeWithdrawnDuplicates,
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
  requiredAssessments: 2,
};

interface Fixture {
  id: string;
  status: RollupEnrollmentStatus;
  withdrawnOn: string | null;
  overall: RequirementStatus;
}

// Build a fixture by running it through the SAME compliance engine both
// dashboards use. This is what makes the test meaningful: the engine is
// identical across paths, so any disagreement in the at-risk count can only
// come from which rows each path feeds in.
//
// The Q1 deadlines for HRAs and QI advising (both Mar 31) have passed by
// ASOF (May 28). To model a genuinely on-track active enrollment the
// fixture sets assessmentsCompleted AND advisingCompleted per the caller —
// otherwise the schedule-aware evaluators would (correctly) flag those
// requirements at_risk, which would muddy the at-risk-by-withdrawal
// accounting this test is really checking.
function makeFixture(
  id: string,
  status: ProgramYearProgress['enrollmentStatus'],
  withdrawnOn: string | null,
  assessmentsCompleted = 0,
  advisingCompleted = 0,
): Fixture {
  const result = evaluateProgramYear(
    activeThresholds,
    {
      meetingsAttended: 0,
      advisingCompleted,
      dataSubmissionsCompleted: 0,
      assessmentsCompleted,
      enrollmentStatus: status,
    },
    { programYear: PROGRAM_YEAR, asOf: ASOF },
  );
  return { id, status, withdrawnOn, overall: result.overall };
}

const enrollments: Fixture[] = [
  // Q1 HRA + Q1 advising done → both schedule-aware evaluators are satisfied
  // → overall on_track.
  makeFixture('active', 'enrolled', null, 1, 1),
  makeFixture('withdrawn-prior-year', 'withdrawn', '2025-06-01'),
  makeFixture('withdrawn-data-drift', 'withdrawn', null),
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

describe('dedupeWithdrawnDuplicates', () => {
  // Models the Valley View / Southwest track-flip pattern: a hospital has a
  // current enrollment for an initiative AND a withdrawn duplicate from a
  // prior mis-classification. The withdrawn one should not double-count.
  const rows = [
    { id: 'a-enrolled', hospitalId: 'valley-view', status: 'enrolled' as const, withdrawnOn: null },
    { id: 'a-withdrawn', hospitalId: 'valley-view', status: 'withdrawn' as const, withdrawnOn: '2026-06-01' },
    { id: 'b-withdrawn-only', hospitalId: 'lone-withdrawer', status: 'withdrawn' as const, withdrawnOn: '2026-05-01' },
    { id: 'c-enrolled', hospitalId: 'happy-path', status: 'enrolled' as const, withdrawnOn: null },
  ];

  it('drops the withdrawn duplicate when the same hospital has a current enrollment', () => {
    const out = dedupeWithdrawnDuplicates(rows, (r) => r.hospitalId);
    const ids = out.map((r) => r.id).sort();
    // a-withdrawn dropped (a-enrolled present); b-withdrawn-only kept (no
    // current enrollment for that hospital).
    expect(ids).toEqual(['a-enrolled', 'b-withdrawn-only', 'c-enrolled']);
  });

  it('is a no-op when there are no duplicates', () => {
    const enrolledOnly = rows.filter((r) => r.status === 'enrolled');
    expect(dedupeWithdrawnDuplicates(enrolledOnly, (r) => r.hospitalId)).toEqual(enrolledOnly);
  });

  it('treats different keys as independent (per-initiative scoping)', () => {
    const mixed = [
      { id: 'soar-enrolled', hospitalId: 'valley-view', status: 'enrolled' as const, withdrawnOn: null, initiativeId: 'soar' },
      { id: 'soar-withdrawn', hospitalId: 'valley-view', status: 'withdrawn' as const, withdrawnOn: '2026-06-01', initiativeId: 'soar' },
      { id: 'ttt-withdrawn', hospitalId: 'valley-view', status: 'withdrawn' as const, withdrawnOn: '2026-06-01', initiativeId: 'ttt' },
    ];
    const out = dedupeWithdrawnDuplicates(mixed, (r) => `${r.hospitalId}::${r.initiativeId}`);
    // soar-withdrawn dropped (duplicate of soar-enrolled), ttt-withdrawn kept
    // (no ttt-enrolled to dedupe against — could be a real mid-year withdrawal).
    expect(out.map((r) => r.id).sort()).toEqual(['soar-enrolled', 'ttt-withdrawn']);
  });
});
