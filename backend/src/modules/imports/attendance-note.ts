/**
 * Pure helper (no DB deps, so it's unit-testable) for reading the Meeting
 * Attendance "Notes" column, which is now an explicit per-hospital attendance
 * dropdown ("attended" / "did not attend"). Every enrolled hospital gets a row;
 * attendance is read here instead of inferred from a row's presence.
 *
 * Returns 'attended' | 'missed', or null when the cell says neither (the caller
 * decides what to do). The negative is checked first because "did not attend"
 * contains the substring "attend".
 */
export function parseAttendanceNote(notes: string): 'attended' | 'missed' | null {
  const n = notes.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!n) return null;
  if (
    n.includes('did not attend') ||
    n.includes("didn't attend") ||
    n.includes('no show') ||
    n.includes('missed') ||
    n === 'no' ||
    n === 'absent'
  ) {
    return 'missed';
  }
  if (n.includes('attend') || n === 'yes' || n === 'present') return 'attended';
  return null;
}
