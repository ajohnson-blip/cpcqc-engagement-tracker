import { describe, expect, it } from 'vitest';
import {
  REQUIRED_ASSESSMENTS_PER_YEAR,
  evaluateHraSchedule,
  hraScheduleOverrideFor,
  scheduleHraInstances,
} from './hra.js';
import {
  evaluateProgramYear,
  type ProgramYearProgress,
  type ProgramYearThresholds,
} from './compliance.service.js';
import { quarterOf } from '../../utils/period.js';

// TTT active program-year config. The only field under test is requiredAssessments,
// which now comes from the shared HRA rule (2 for every initiative and track).
const tttActive2026Thresholds: ProgramYearThresholds = {
  requiredMeetings: 9,
  requiredAdvising: 4,
  requiredDataPeriods: 12,
  dataSubmissionsMin: 12,
  requiredAssessments: REQUIRED_ASSESSMENTS_PER_YEAR,
};

const zeroProgress: ProgramYearProgress = {
  meetingsAttended: 0,
  advisingCompleted: 0,
  dataSubmissionsCompleted: 0,
  assessmentsCompleted: 0,
  enrollmentStatus: 'enrolled',
};

describe('HRAs are required bi-annually for every initiative and track', () => {
  it('TTT active 2026 with zero HRAs is not_met after year end', () => {
    // Guards the rule itself: if the config silently reverts to 0, requiredAssessments
    // becomes 0, the engine skips HRAs, and assessments is undefined (not not_met).
    expect(REQUIRED_ASSESSMENTS_PER_YEAR).toBe(2);

    const result = evaluateProgramYear(tttActive2026Thresholds, zeroProgress, {
      programYear: 2026,
      asOf: new Date('2027-01-15T12:00:00Z'), // after Dec 31, 2026
    });

    expect(result.assessments?.status).toBe('not_met');
    expect(result.overall).toBe('not_met');
  });
});

describe('SPARK 2026 HRA schedule override', () => {
  // Two HRA templates with the standard default labels; scheduling maps them onto
  // the effective quarters by order, so the labels here only set the ordering.
  const hraTemplates = [
    { id: 'hra-early', periodLabel: 'Q1' },
    { id: 'hra-late', periodLabel: 'Q4' },
  ];

  it('schedules SPARK 2026 HRAs in Q2 and Q4', () => {
    const scheduled = scheduleHraInstances(
      hraTemplates,
      2026,
      hraScheduleOverrideFor('SPARK', 2026),
    );
    const byId = new Map(scheduled.map((s) => [s.templateId, s]));

    expect(byId.get('hra-early')!.period).toBe('2026-Q2');
    expect(byId.get('hra-early')!.dueOn).toBe('2026-06-30');
    expect(quarterOf(new Date(byId.get('hra-early')!.dueOn))).toBe(2);

    expect(byId.get('hra-late')!.period).toBe('2026-Q4');
    expect(byId.get('hra-late')!.dueOn).toBe('2026-12-31');
    expect(quarterOf(new Date(byId.get('hra-late')!.dueOn))).toBe(4);
  });

  it('milestone-aware: 0/2 after Q1 deadline → at_risk (the AdventHealth Littleton case)', () => {
    // TTT 2026, default Q1 + Q4 schedule, asOf 2026-06-01.
    // Q1's deadline (Mar 31) has passed without a completion — the engine
    // should flag at_risk for assessments rather than waiting until mid-year
    // like the old yearFraction-based threshold did.
    const result = evaluateHraSchedule(null, 0, 2026, new Date('2026-06-01T12:00:00Z'));
    expect(result.status).toBe('at_risk');
    expect(result.expected).toBe(1);
    expect(result.current).toBe(0);
    expect(result.required).toBe(2);
  });

  it('milestone-aware: 1/2 after Q1 deadline → on_track (caught up to the milestone)', () => {
    const result = evaluateHraSchedule(null, 1, 2026, new Date('2026-06-01T12:00:00Z'));
    expect(result.status).toBe('on_track');
    expect(result.expected).toBe(1);
  });

  it('milestone-aware: before any deadline → on_track even with 0 completions', () => {
    // Mid-February 2026 — Q1 ends March 31, no deadlines have passed yet.
    const result = evaluateHraSchedule(null, 0, 2026, new Date('2026-02-15T12:00:00Z'));
    expect(result.status).toBe('on_track');
    expect(result.expected).toBe(0);
  });

  it('milestone-aware: SPARK 2026 stays on_track at 0/2 in June (Q2 deadline not yet passed)', () => {
    // SPARK 2026's first HRA is due Q2 (June 30), not Q1. A 0/2 on June 1
    // is genuinely not late yet — should stay on_track until the Q2 deadline.
    const result = evaluateHraSchedule(
      hraScheduleOverrideFor('SPARK', 2026),
      0,
      2026,
      new Date('2026-06-01T12:00:00Z'),
    );
    expect(result.status).toBe('on_track');
    expect(result.expected).toBe(0);
  });

  it('milestone-aware: SPARK 2026 flips to at_risk in July (Q2 deadline passed)', () => {
    const result = evaluateHraSchedule(
      hraScheduleOverrideFor('SPARK', 2026),
      0,
      2026,
      new Date('2026-07-15T12:00:00Z'),
    );
    expect(result.status).toBe('at_risk');
    expect(result.expected).toBe(1);
  });

  it('milestone-aware: 2/2 → met regardless of date', () => {
    expect(
      evaluateHraSchedule(null, 2, 2026, new Date('2026-04-15T12:00:00Z')).status,
    ).toBe('met');
  });

  it('milestone-aware: incomplete at year-end → not_met', () => {
    expect(
      evaluateHraSchedule(null, 1, 2026, new Date('2027-01-15T12:00:00Z')).status,
    ).toBe('not_met');
  });

  it('keeps the standard Q1 + Q4 for SPARK 2027 (no override — not hard-coded to SPARK)', () => {
    const scheduled = scheduleHraInstances(
      hraTemplates,
      2027,
      hraScheduleOverrideFor('SPARK', 2027),
    );
    const byId = new Map(scheduled.map((s) => [s.templateId, s]));

    expect(hraScheduleOverrideFor('SPARK', 2027)).toBeNull();
    expect(byId.get('hra-early')!.dueOn).toBe('2027-03-31');
    expect(quarterOf(new Date(byId.get('hra-early')!.dueOn))).toBe(1);
    expect(byId.get('hra-late')!.dueOn).toBe('2027-12-31');
    expect(quarterOf(new Date(byId.get('hra-late')!.dueOn))).toBe(4);
  });
});
