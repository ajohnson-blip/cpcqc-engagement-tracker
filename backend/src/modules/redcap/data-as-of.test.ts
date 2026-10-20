import { describe, expect, it } from 'vitest';
import {
  endOfDeadlineDay,
  fileAgeHours,
  isStale,
  mountainMidnight,
  predatesDeadlineDayEnd,
  STALE_AFTER_HOURS,
} from './data-as-of.js';

describe('mountainMidnight', () => {
  it('is 06:00 UTC in daylight time and 07:00 UTC in standard time', () => {
    expect(mountainMidnight('2026-07-15').toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(mountainMidnight('2026-01-15').toISOString()).toBe('2026-01-15T07:00:00.000Z');
  });

  it('is right on the days the clocks change', () => {
    // DST begins 2026-03-08 and ends 2026-11-01, both at 2am — after midnight.
    expect(mountainMidnight('2026-03-08').toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(mountainMidnight('2026-03-09').toISOString()).toBe('2026-03-09T06:00:00.000Z');
    expect(mountainMidnight('2026-11-01').toISOString()).toBe('2026-11-01T06:00:00.000Z');
    expect(mountainMidnight('2026-11-02').toISOString()).toBe('2026-11-02T07:00:00.000Z');
  });
});

describe('endOfDeadlineDay', () => {
  it('is the following midnight, Mountain time', () => {
    // SOAR's September 2026 deadline, the 2nd Friday of October.
    expect(endOfDeadlineDay('2026-10-09').toISOString()).toBe('2026-10-10T06:00:00.000Z');
    expect(endOfDeadlineDay('2026-12-31').toISOString()).toBe('2027-01-01T07:00:00.000Z');
  });
});

describe('predatesDeadlineDayEnd', () => {
  it('is true for data produced during the deadline day', () => {
    // 11:30pm Mountain on deadline day — a submission at 11:45pm is missing.
    expect(predatesDeadlineDayEnd('2026-10-10T05:30:00Z', '2026-10-09')).toBe(true);
  });

  it('is false for data produced after the deadline day ended', () => {
    // 12:05am Mountain the next day: everything from the deadline day is in.
    expect(predatesDeadlineDayEnd('2026-10-10T06:05:00Z', '2026-10-09')).toBe(false);
  });

  it('is false when either date is unusable, rather than blocking on bad input', () => {
    expect(predatesDeadlineDayEnd('not a time', '2026-10-09')).toBe(false);
    expect(predatesDeadlineDayEnd('2026-10-10T05:30:00Z', '9 Oct')).toBe(false);
  });
});

describe('file age', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  it('measures hours since the file was produced', () => {
    expect(fileAgeHours('2026-10-21T06:00:00Z', now)).toBe(6);
  });

  it('is stale only once more than one missed night would explain', () => {
    expect(isStale(new Date(now.getTime() - (STALE_AFTER_HOURS - 1) * 3_600_000).toISOString(), now)).toBe(false);
    expect(isStale(new Date(now.getTime() - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString(), now)).toBe(true);
  });
});
