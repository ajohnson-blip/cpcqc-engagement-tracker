import { describe, expect, it } from 'vitest';
import {
  evaluateProgramYear,
  yearProgressFraction,
  type ProgramYearThresholds,
  type ProgramYearProgress,
  type EvaluationContext,
} from './compliance.service.js';

// HRAs are required bi-annually for every initiative and track, so active and
// SPARK configs carry requiredAssessments: 2 just like sustainability.
const activeThresholds: ProgramYearThresholds = {
  requiredMeetings: 9,
  requiredAdvising: 4,
  requiredDataPeriods: 12,
  dataSubmissionsMin: 12,
  requiredAssessments: 2,
};

const sparkThresholds: ProgramYearThresholds = {
  requiredMeetings: 9,
  requiredAdvising: 4,
  requiredDataPeriods: 4,
  dataSubmissionsMin: 3, // ≥3 of 4 quarters
  requiredAssessments: 2,
};

const sustainabilityThresholds: ProgramYearThresholds = {
  requiredMeetings: 4,
  requiredAdvising: 2,
  requiredDataPeriods: 1,
  dataSubmissionsMin: 1,
  requiredAssessments: 2,
};

const enrolled = (overrides: Partial<ProgramYearProgress> = {}): ProgramYearProgress => ({
  meetingsAttended: 0,
  advisingCompleted: 0,
  dataSubmissionsCompleted: 0,
  assessmentsCompleted: 0,
  enrollmentStatus: 'enrolled',
  ...overrides,
});

const earlyInYear = (): EvaluationContext => ({ programYear: 2026, asOf: new Date('2026-02-15T12:00:00Z') });
const midYear = (): EvaluationContext => ({ programYear: 2026, asOf: new Date('2026-07-01T12:00:00Z') });
const lateInYear = (): EvaluationContext => ({ programYear: 2026, asOf: new Date('2026-11-15T12:00:00Z') });
const afterYear = (): EvaluationContext => ({ programYear: 2026, asOf: new Date('2027-01-15T12:00:00Z') });

describe('yearProgressFraction', () => {
  it('returns 0 before the year', () => {
    expect(yearProgressFraction(2026, new Date('2025-12-31T23:00:00Z'))).toBe(0);
  });
  it('returns 1 after the year', () => {
    expect(yearProgressFraction(2026, new Date('2027-02-01T00:00:00Z'))).toBe(1);
  });
  it('returns ~0.5 mid year', () => {
    const f = yearProgressFraction(2026, new Date('2026-07-02T12:00:00Z'));
    expect(f).toBeGreaterThan(0.49);
    expect(f).toBeLessThan(0.51);
  });
});

describe('active track — happy path', () => {
  it('fully on-track hospital is on_track or met at mid-year', () => {
    // The Q1 HRA deadline (Mar 31) has passed by mid-year, so a hospital that
    // is "fully on track" must have at least the Q1 HRA done — otherwise the
    // schedule-aware HRA evaluator (correctly) flips assessments to at_risk.
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({
        meetingsAttended: 5,
        advisingCompleted: 2,
        dataSubmissionsCompleted: 6,
        assessmentsCompleted: 1,
      }),
      midYear(),
    );
    expect(result.meetings.status).toBe('on_track');
    expect(result.advising.status).toBe('on_track');
    expect(result.dataSubmissions.status).toBe('on_track');
    expect(result.overall).toBe('on_track');
  });

  it('completing all requirements early returns met for each', () => {
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({
        meetingsAttended: 9,
        advisingCompleted: 4,
        dataSubmissionsCompleted: 12,
        assessmentsCompleted: 2,
      }),
      midYear(),
    );
    expect(result.meetings.status).toBe('met');
    expect(result.advising.status).toBe('met');
    expect(result.dataSubmissions.status).toBe('met');
    expect(result.assessments?.status).toBe('met');
    expect(result.overall).toBe('met');
  });
});

describe('QI advising — quarterly milestone schedule', () => {
  // Active hospitals attend one advising session per quarter (Q1, Q2, Q3, Q4).
  // The engine now flags at_risk when a quarter's deadline has passed without
  // a session, matching the policy and matching how HRAs are judged.
  it('active hospital with 0 sessions after Q1 deadline → at_risk (Wray case)', () => {
    // June 2, 2026 — Q1 ended Mar 31, no advising recorded.
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({ advisingCompleted: 0 }),
      { programYear: 2026, asOf: new Date('2026-06-02T12:00:00Z') },
    );
    expect(result.advising.status).toBe('at_risk');
    expect(result.advising.expected).toBe(1);
  });

  it('active hospital with 1 session after Q1 deadline → on_track (caught up)', () => {
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({ advisingCompleted: 1 }),
      { programYear: 2026, asOf: new Date('2026-06-02T12:00:00Z') },
    );
    expect(result.advising.status).toBe('on_track');
  });

  it('active hospital before any quarter deadline → on_track even at 0 sessions', () => {
    // Mid-February: Q1 ends Mar 31; no deadline passed yet.
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({ advisingCompleted: 0 }),
      { programYear: 2026, asOf: new Date('2026-02-15T12:00:00Z') },
    );
    expect(result.advising.status).toBe('on_track');
    expect(result.advising.expected).toBe(0);
  });

  it('sustainability hospital uses bi-annual schedule (Q2 + Q4)', () => {
    // June 2: Q2 (June 30) hasn't passed yet, so 0 sessions still on_track.
    const result = evaluateProgramYear(
      sustainabilityThresholds,
      enrolled({ advisingCompleted: 0, assessmentsCompleted: 1 }),
      { programYear: 2026, asOf: new Date('2026-06-02T12:00:00Z') },
    );
    expect(result.advising.status).toBe('on_track');
    // After Q2's June 30 deadline, 0 sessions flips to at_risk.
    const afterQ2 = evaluateProgramYear(
      sustainabilityThresholds,
      enrolled({ advisingCompleted: 0, assessmentsCompleted: 1 }),
      { programYear: 2026, asOf: new Date('2026-07-15T12:00:00Z') },
    );
    expect(afterQ2.advising.status).toBe('at_risk');
  });
});

describe('active track — at risk / not met', () => {
  it('hospital with no progress in November is at_risk on multiple axes', () => {
    // Late in year + zero progress = catastrophically behind.
    const result = evaluateProgramYear(activeThresholds, enrolled(), lateInYear());
    expect(result.meetings.status).toBe('at_risk');
    expect(result.advising.status).toBe('at_risk');
    expect(result.dataSubmissions.status).toBe('at_risk');
    expect(result.overall).toBe('at_risk');
  });

  it('after year ends with incomplete requirements is not_met', () => {
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({ meetingsAttended: 7, advisingCompleted: 3, dataSubmissionsCompleted: 10 }),
      afterYear(),
    );
    expect(result.meetings.status).toBe('not_met');
    expect(result.advising.status).toBe('not_met');
    expect(result.dataSubmissions.status).toBe('not_met');
    expect(result.overall).toBe('not_met');
  });

  it('early-in-year hospital with zero progress is NOT at_risk (retrospective model)', () => {
    // Pre-mid-year, we never flag at_risk. The hospital still has runway.
    const result = evaluateProgramYear(activeThresholds, enrolled(), earlyInYear());
    expect(result.meetings.status).toBe('on_track');
    expect(result.dataSubmissions.status).toBe('on_track');
  });

  it('mid-year hospital with some progress stays on_track even if behind pace', () => {
    // Mid-year + lagging on the threshold-judged axes (meetings, data) → don't
    // shame. For advising (now milestone-judged) the hospital needs to be at
    // least caught up to its Q1 + Q2 quarter deadlines — 2 sessions by July —
    // otherwise the engine correctly flags it at_risk.
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({ meetingsAttended: 3, advisingCompleted: 2, dataSubmissionsCompleted: 4 }),
      midYear(),
    );
    expect(result.meetings.status).toBe('on_track');
    expect(result.advising.status).toBe('on_track');
    expect(result.dataSubmissions.status).toBe('on_track');
  });
});

describe('SPARK quarterly data with 3-of-4 rule', () => {
  it('3 quarters submitted = met (even though 4 are possible)', () => {
    const result = evaluateProgramYear(
      sparkThresholds,
      enrolled({ meetingsAttended: 9, advisingCompleted: 4, dataSubmissionsCompleted: 3 }),
      afterYear(),
    );
    expect(result.dataSubmissions.status).toBe('met');
  });

  it('2 quarters submitted at year end = not_met for data', () => {
    const result = evaluateProgramYear(
      sparkThresholds,
      enrolled({ meetingsAttended: 9, advisingCompleted: 4, dataSubmissionsCompleted: 2 }),
      afterYear(),
    );
    expect(result.dataSubmissions.status).toBe('not_met');
  });
});

describe('sustainability track (SOAR 2026)', () => {
  it('meets the lower bar (4/2/1/2)', () => {
    const result = evaluateProgramYear(
      sustainabilityThresholds,
      enrolled({
        meetingsAttended: 4,
        advisingCompleted: 2,
        dataSubmissionsCompleted: 1,
        assessmentsCompleted: 2,
      }),
      afterYear(),
    );
    expect(result.overall).toBe('met');
    expect(result.assessments?.status).toBe('met');
  });

  it('missing one HRA after year end is not_met', () => {
    const result = evaluateProgramYear(
      sustainabilityThresholds,
      enrolled({
        meetingsAttended: 4,
        advisingCompleted: 2,
        dataSubmissionsCompleted: 1,
        assessmentsCompleted: 1,
      }),
      afterYear(),
    );
    expect(result.assessments?.status).toBe('not_met');
    expect(result.overall).toBe('not_met');
  });

  it('does not produce an assessments result when requiredAssessments is 0', () => {
    // The engine only evaluates HRAs when requiredAssessments > 0. (In production
    // every track now requires 2; this guards the zero branch directly.)
    const noHraThresholds: ProgramYearThresholds = { ...activeThresholds, requiredAssessments: 0 };
    const result = evaluateProgramYear(
      noHraThresholds,
      enrolled({ meetingsAttended: 9, advisingCompleted: 4, dataSubmissionsCompleted: 12 }),
      afterYear(),
    );
    expect(result.assessments).toBeUndefined();
  });
});

describe('withdrawn / unenrolled hospitals', () => {
  it('withdrawn hospital flags enrollment requirement', () => {
    const result = evaluateProgramYear(
      activeThresholds,
      enrolled({
        enrollmentStatus: 'withdrawn',
        meetingsAttended: 5,
        advisingCompleted: 2,
        dataSubmissionsCompleted: 6,
      }),
      midYear(),
    );
    expect(result.enrollment.status).toBe('at_risk');
    // Non-enrollment requirements are still evaluated independently
    expect(result.meetings.status).toBe('on_track');
  });
});
