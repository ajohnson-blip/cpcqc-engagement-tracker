import { describe, expect, it } from 'vitest';
import { computePeriodString, computeDueDate, quarterOf } from './period.js';

describe('computePeriodString', () => {
  it('annual/once produces a yearly period', () => {
    expect(computePeriodString('annual', 'Annual', 2026)).toBe('2026-annual');
    expect(computePeriodString('once', null, 2027)).toBe('2027-annual');
  });
  it('quarterly produces "YYYY-Qn"', () => {
    expect(computePeriodString('quarterly', 'Q1', 2026)).toBe('2026-Q1');
    expect(computePeriodString('quarterly', 'q4', 2026)).toBe('2026-Q4');
  });
  it('monthly produces "YYYY-MM"', () => {
    expect(computePeriodString('monthly', 'January', 2026)).toBe('2026-01');
    expect(computePeriodString('monthly', 'December', 2026)).toBe('2026-12');
  });
  it('rejects unknown labels', () => {
    expect(() => computePeriodString('quarterly', 'Q5', 2026)).toThrow();
    expect(() => computePeriodString('monthly', 'Smarch', 2026)).toThrow();
  });
});

describe('computeDueDate', () => {
  it('annual due date is Dec 31 of the program year', () => {
    expect(computeDueDate('annual', 'Annual', 2026)).toBe('2026-12-31');
  });
  it('quarterly due dates land on quarter-end', () => {
    expect(computeDueDate('quarterly', 'Q1', 2026)).toBe('2026-03-31');
    expect(computeDueDate('quarterly', 'Q2', 2026)).toBe('2026-06-30');
    expect(computeDueDate('quarterly', 'Q3', 2026)).toBe('2026-09-30');
    expect(computeDueDate('quarterly', 'Q4', 2026)).toBe('2026-12-31');
  });
  it('monthly due dates land on month-end', () => {
    expect(computeDueDate('monthly', 'January', 2026)).toBe('2026-01-31');
    expect(computeDueDate('monthly', 'February', 2026)).toBe('2026-02-28');
    expect(computeDueDate('monthly', 'February', 2028)).toBe('2028-02-29'); // leap
    expect(computeDueDate('monthly', 'April', 2026)).toBe('2026-04-30');
  });
});

describe('quarterOf', () => {
  it('maps months to quarters', () => {
    expect(quarterOf(new Date('2026-01-15T00:00:00Z'))).toBe(1);
    expect(quarterOf(new Date('2026-04-01T00:00:00Z'))).toBe(2);
    expect(quarterOf(new Date('2026-07-31T00:00:00Z'))).toBe(3);
    expect(quarterOf(new Date('2026-12-31T00:00:00Z'))).toBe(4);
  });
});
