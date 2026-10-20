/**
 * When sync data was produced, measured against what it is being used for.
 *
 * Pure — no `@/` imports — so it is unit testable.
 *
 * Two questions:
 *  - Is the data old? A preview built from CHA's nightly file says how old the
 *    file is, and warns when it is older than one missed night would explain.
 *  - Could it have missed a deadline-day submission? CPCQC deadlines are
 *    calendar days in Mountain time, so data produced before midnight Mountain
 *    at the END of the deadline day may lack submissions made late that day.
 *    Finalizing a month from such data would lock the omission in.
 */

const MOUNTAIN = 'America/Denver';

/**
 * A nightly file older than this means at least one night's run is missing:
 * 24 hours between runs, plus room for a run that started late.
 */
export const STALE_AFTER_HOURS = 30;

export function fileAgeHours(generatedAtIso: string, now: Date = new Date()): number {
  return (now.getTime() - Date.parse(generatedAtIso)) / 3_600_000;
}

export function isStale(generatedAtIso: string, now: Date = new Date()): boolean {
  return fileAgeHours(generatedAtIso, now) > STALE_AFTER_HOURS;
}

/** Offset of `timeZone` from UTC at `at`, in minutes (Mountain: -360 or -420). */
function offsetMinutes(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value; // "GMT-06:00"
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? '');
  if (!m) return 0; // "GMT" alone: UTC itself
  const minutes = parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10);
  return m[1] === '-' ? -minutes : minutes;
}

/** The instant midnight begins `dateIso` (YYYY-MM-DD) in Mountain time. */
export function mountainMidnight(dateIso: string): Date {
  const utcMidnight = Date.parse(`${dateIso}T00:00:00Z`);
  // DST changes at 2am local, so midnight is never skipped or repeated; one
  // correction from the offset at the first guess is exact.
  const guess = utcMidnight - offsetMinutes(new Date(utcMidnight), MOUNTAIN) * 60_000;
  return new Date(utcMidnight - offsetMinutes(new Date(guess), MOUNTAIN) * 60_000);
}

/** The instant a deadline day (YYYY-MM-DD) ends: the following midnight, Mountain time. */
export function endOfDeadlineDay(deadlineIso: string): Date {
  const next = new Date(Date.parse(`${deadlineIso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return mountainMidnight(next);
}

/**
 * True when data produced at `dataAsOfIso` may lack submissions made on the
 * deadline day — it was produced before that day ended.
 */
export function predatesDeadlineDayEnd(dataAsOfIso: string, deadlineIso: string): boolean {
  const asOf = Date.parse(dataAsOfIso);
  if (Number.isNaN(asOf) || !/^\d{4}-\d{2}-\d{2}$/.test(deadlineIso)) return false;
  return asOf < endOfDeadlineDay(deadlineIso).getTime();
}

/**
 * Where a sync's data came from and when it was produced — shown on every
 * preview, so nobody mistakes last night's file for live data, and recorded on
 * every task an apply changes, so finalizing can check it.
 */
export interface SyncDataSource {
  kind: 'redcap' | 'cha';
  /** When the data was produced: the start of the REDCap read, or the file's generated_at. */
  generatedAt: string;
  /** The CHA file, when there is one. */
  snapshotId: string | null;
  generatorVersion: string | null;
  methodologyVersion: string | null;
  ageHours: number;
  stale: boolean;
}

export function describeSource(
  kind: SyncDataSource['kind'],
  generatedAt: string,
  extra: Pick<SyncDataSource, 'snapshotId' | 'generatorVersion' | 'methodologyVersion'> = {
    snapshotId: null,
    generatorVersion: null,
    methodologyVersion: null,
  },
  now: Date = new Date(),
): SyncDataSource {
  const ageHours = Math.max(0, fileAgeHours(generatedAt, now));
  // A live REDCap read is never stale; it was produced just now.
  return { kind, generatedAt, ...extra, ageHours, stale: kind === 'cha' && ageHours > STALE_AFTER_HOURS };
}
