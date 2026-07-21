import { describe, expect, it } from 'vitest';
import {
  thirdFriday,
  monthDeadline,
  monthCodeToPeriod,
  patientPeriod,
  patientEligible,
  checkCompleteness,
  linkageFloorMet,
  linkageIdealMet,
  classifyTtt,
  type RedcapRow,
  type TttDecisionInput,
} from './ttt-engagement.js';

describe('deadlines (3rd Friday of the following month)', () => {
  it('matches the CPCQC TtT schedule (Jun–Nov align with the sheet)', () => {
    expect(monthDeadline(2026, 1)).toBe('2026-02-20'); // Jan → Feb 20
    expect(monthDeadline(2026, 3)).toBe('2026-04-17'); // Mar → Apr 17
    expect(monthDeadline(2026, 6)).toBe('2026-07-17'); // Jun → Jul 17 (sheet: 7/17)
    expect(monthDeadline(2026, 11)).toBe('2026-12-18'); // Nov → Dec 18 (sheet: 12/18)
    // Dec computes to the 3rd Friday (1/15); the sheet uses 1/22 (a 4th-Friday
    // exception) — the sync honors the task due_on for that, this is the fallback.
    expect(monthDeadline(2026, 12)).toBe('2027-01-15');
  });
  it('computes the 3rd Friday', () => {
    expect(thirdFriday(2026, 7)).toBe('2026-07-17');
  });
});

describe('monthCodeToPeriod (code 1 = Jan 2025)', () => {
  it('maps codes to YYYY-MM', () => {
    expect(monthCodeToPeriod(1)).toBe('2025-01');
    expect(monthCodeToPeriod(13)).toBe('2026-01');
    expect(monthCodeToPeriod(24)).toBe('2026-12');
    expect(monthCodeToPeriod(25)).toBe('2027-01');
  });
  it('rejects blank / bad codes', () => {
    expect(monthCodeToPeriod('')).toBeNull();
    expect(monthCodeToPeriod('x')).toBeNull();
    expect(monthCodeToPeriod(0)).toBeNull();
  });
});

describe('patientPeriod (from delivery_date_1)', () => {
  it('extracts YYYY-MM from a valid date', () => {
    expect(patientPeriod({ delivery_date_1: '2026-01-14' })).toBe('2026-01');
  });
  it('null for missing / corrupt date', () => {
    expect(patientPeriod({ delivery_date_1: '' })).toBeNull();
    expect(patientPeriod({ delivery_date_1: '#junk' })).toBeNull();
  });
});

describe('patientEligible', () => {
  function row(extra: RedcapRow): RedcapRow {
    return extra;
  }
  it('derived: qualifying substance + not ineligible → eligible (the blank-checkbox case)', () => {
    expect(patientEligible(row({ sample_check_patient: '', substances_used_2___4: '1' }), 'derived')).toBe(true);
    expect(patientEligible(row({ sample_check_patient: '1', substances_used_2___1: '1' }), 'derived')).toBe(true);
  });
  it('derived: explicitly ineligible (==2) is excluded even with a substance', () => {
    expect(patientEligible(row({ sample_check_patient: '2', substances_used_2___1: '1' }), 'derived')).toBe(false);
  });
  it('derived: cannabis-only (7) / nicotine-only (10) do not qualify', () => {
    expect(patientEligible(row({ substances_used_2___7: '1' }), 'derived')).toBe(false);
    expect(patientEligible(row({ substances_used_2___10: '1' }), 'derived')).toBe(false);
  });
  it('explicit vs derived differ for a marked-eligible row with no qualifying substance', () => {
    const r = row({ sample_check_patient: '1' }); // eligible flag, no substance
    expect(patientEligible(r, 'explicit')).toBe(true);
    expect(patientEligible(r, 'derived')).toBe(false);
    expect(patientEligible(r, 'either')).toBe(true);
  });
});

describe('checkCompleteness', () => {
  it('flags blank required fields', () => {
    const res = checkCompleteness({ a: '1', b: '', c: '3' }, ['a', 'b', 'c']);
    expect(res.complete).toBe(false);
    expect(res.missing).toEqual(['b']);
  });
  it('complete when all required present', () => {
    expect(checkCompleteness({ a: '1', b: '2' }, ['a', 'b']).complete).toBe(true);
  });
});

describe('linkage', () => {
  it('floor: positives>0 needs ≥1 form; NA when no positives', () => {
    expect(linkageFloorMet(5, 0)).toBe(false);
    expect(linkageFloorMet(5, 1)).toBe(true);
    expect(linkageFloorMet(0, 0)).toBe(true);
  });
  it('ideal: one form per positive', () => {
    expect(linkageIdealMet(5, 3)).toBe(false);
    expect(linkageIdealMet(5, 5)).toBe(true);
    expect(linkageIdealMet(0, 0)).toBe(true);
  });
});

describe('classifyTtt', () => {
  const base: TttDecisionInput = {
    submitted: true,
    deadlinePassed: true,
    onTime: true,
    complete: true,
    missing: [],
    linkageFloor: true,
    linkageIdeal: true,
    positiveScreens: 3,
    patientForms: 3,
  };
  it('compliant → counting', () => {
    expect(classifyTtt(base).category).toBe('counting');
  });
  it('floor met but below ideal → still counts', () => {
    expect(classifyTtt({ ...base, linkageIdeal: false, patientForms: 1 }).category).toBe('below_ideal');
  });
  it('linkage floor failed → incomplete (needs revision)', () => {
    expect(classifyTtt({ ...base, linkageFloor: false, patientForms: 0 }).category).toBe('incomplete');
  });
  it('missing required field → incomplete', () => {
    expect(classifyTtt({ ...base, complete: false, missing: ['tot_sud_scrnd_pos'] }).category).toBe('incomplete');
  });
  it('complete + floor met but late → complete_late', () => {
    expect(classifyTtt({ ...base, onTime: false }).category).toBe('complete_late');
  });
  it('no submission after deadline → not_submitted; before → pending', () => {
    expect(classifyTtt({ ...base, submitted: false, deadlinePassed: true }).category).toBe('not_submitted');
    expect(classifyTtt({ ...base, submitted: false, deadlinePassed: false }).category).toBe('pending');
  });
});
