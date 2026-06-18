import { describe, expect, it } from 'vitest';
import { parseAttendanceNote } from './attendance-note.js';

describe('parseAttendanceNote', () => {
  it('reads the explicit dropdown values', () => {
    expect(parseAttendanceNote('attended')).toBe('attended');
    expect(parseAttendanceNote('did not attend')).toBe('missed');
  });

  it('is case- and whitespace-tolerant', () => {
    expect(parseAttendanceNote('  Attended ')).toBe('attended');
    expect(parseAttendanceNote('Did Not Attend')).toBe('missed');
    expect(parseAttendanceNote('did   not   attend')).toBe('missed');
  });

  it('checks the negative first so "did not attend" is not read as "attend"', () => {
    expect(parseAttendanceNote("didn't attend")).toBe('missed');
    expect(parseAttendanceNote('no show')).toBe('missed');
    expect(parseAttendanceNote('absent')).toBe('missed');
    expect(parseAttendanceNote('missed')).toBe('missed');
  });

  it('returns null for blank or descriptive notes (caller decides)', () => {
    expect(parseAttendanceNote('')).toBeNull();
    expect(parseAttendanceNote('   ')).toBeNull();
    // Legacy descriptive example-row note — no attendance keyword.
    expect(parseAttendanceNote('Feb 2026 SOAR monthly cohort meeting.')).toBeNull();
  });
});
