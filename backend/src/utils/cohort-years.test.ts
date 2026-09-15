import { describe, expect, it } from 'vitest';
import { cohortYears } from './period.js';

describe('cohortYears', () => {
  it('covers every year of a cohort by default', () => {
    expect(cohortYears('2026-01-01', '2027-12-31')).toEqual([2026, 2027]);
    expect(cohortYears('2026-01-01', '2026-12-31')).toEqual([2026]);
  });

  it('joins partway through — year 2 only, without recreating year 1', () => {
    // UCHealth Memorial North: covered under the combined record in 2026,
    // its own TtT enrollment from 2027.
    expect(cohortYears('2026-01-01', '2027-12-31', 2027)).toEqual([2027]);
  });

  it('refuses a join year outside the cohort instead of creating nothing', () => {
    expect(() => cohortYears('2026-01-01', '2027-12-31', 2028)).toThrow(/outside the cohort/);
    expect(() => cohortYears('2026-01-01', '2027-12-31', 2025)).toThrow(/outside the cohort/);
  });
});
