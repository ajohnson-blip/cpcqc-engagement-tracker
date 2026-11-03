/**
 * What a QI 1:1 (qi_advising) task records beyond attendance: brief call
 * notes, the hospital's aims with their PDSA tests of change, and the date of
 * the next 1:1.
 *
 * It lives in the 1:1 task's payload, one snapshot per session, so each
 * period's task keeps where the work stood at that call — the same shape as
 * the advisors' paper sheet, which updates the aims quarter by quarter. The
 * latest snapshot is the hospital's current plan, and a session with no aims
 * yet starts from the one before it. A completed aim stays in the plan, marked
 * with the date, so the record shows what the team achieved.
 *
 * Hospitals and advisors both edit the notes and the aims; attendance, the
 * session date and the next 1:1 stay with CPCQC staff.
 *
 * Pure, so it is testable without a database (the `@/` alias does not resolve
 * under vitest).
 */
import { z } from 'zod';

export const PDSA_STAGES = ['plan', 'do', 'study', 'act'] as const;
/** The Act decision, recorded once a test reaches Act. */
export const PDSA_DECISIONS = ['adopt', 'adapt', 'abandon'] as const;
/** Aims open at once. Completed aims don't count toward it. */
export const MAX_ACTIVE_AIMS = 5;
/** All aims on a 1:1, completed ones included. */
export const MAX_AIMS = 15;
export const MAX_TESTS_PER_AIM = 6;

const text = (max: number) => z.string().trim().max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const pdsaTestSchema = z.object({
  change: text(300).min(1, 'Describe the change being tested.'),
  stage: z.enum(PDSA_STAGES),
  learning: text(600).optional(),
  decision: z.enum(PDSA_DECISIONS).optional(),
});

export const qiAimSchema = z.object({
  statement: text(500).min(1, 'Each aim needs a statement.'),
  tests: z.array(pdsaTestSchema).max(MAX_TESTS_PER_AIM).default([]),
  /** When the team marked the aim complete. */
  completedOn: isoDate.optional(),
});

/** The part both hospitals and advisors edit. */
export const qiAdvisingContentSchema = z.object({
  progress: text(2000).optional(),
  challenges: text(2000).optional(),
  priorities: text(2000).optional(),
  /** Free-text notes, e.g. from the PM spreadsheet upload's QI Advising sheet. */
  notes: text(5000).optional(),
  aims: z
    .array(qiAimSchema)
    .max(MAX_AIMS)
    .refine(
      (aims) => aims.filter((a) => !a.completedOn).length <= MAX_ACTIVE_AIMS,
      `Up to ${MAX_ACTIVE_AIMS} aims can be open at once. Mark one complete to add another.`,
    )
    .optional(),
});

/** The full 1:1 payload; the extra fields are CPCQC staff's. */
export const qiAdvisingPayloadSchema = qiAdvisingContentSchema.extend({
  sessionDate: isoDate.optional(),
  advisorName: z.string().min(1).max(200).optional(),
  attendees: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  /** Null clears it. */
  nextSessionOn: isoDate.nullable().optional(),
});

export type QiAim = z.infer<typeof qiAimSchema>;
export type QiAdvisingContent = z.infer<typeof qiAdvisingContentSchema>;

interface AdvisingTask {
  period: string;
  payload: unknown;
  status?: string;
  outcome?: string | null;
}

function field(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
}

const byPeriodDesc = (a: AdvisingTask, b: AdvisingTask) => b.period.localeCompare(a.period);

/**
 * The most recent session's aims — before `beforePeriod` when given, which is
 * how a new session starts from the last one's plan. Periods sort as text
 * ("2026-Q3" < "2026-Q4" < "2027-Q1").
 */
export function latestAims(
  tasks: AdvisingTask[],
  beforePeriod?: string,
): { aims: QiAim[]; period: string } | null {
  for (const t of [...tasks].sort(byPeriodDesc)) {
    if (beforePeriod !== undefined && t.period >= beforePeriod) continue;
    const aims = field(t.payload, 'aims');
    if (Array.isArray(aims) && aims.length > 0) return { aims: aims as QiAim[], period: t.period };
  }
  return null;
}

/**
 * The next 1:1 date set at the most recent session that set one, while it is
 * still ahead. A date that has passed is not shown: either the 1:1 happened
 * and is waiting to be recorded, or it moved.
 */
export function nextSessionOn(tasks: AdvisingTask[], today: string): string | null {
  for (const t of [...tasks].sort(byPeriodDesc)) {
    const next = field(t.payload, 'nextSessionOn');
    if (typeof next === 'string' && next) return next >= today ? next : null;
  }
  return null;
}

const NOTE_FIELDS = ['progress', 'challenges', 'priorities', 'notes'] as const;

function sessionDateOf(t: AdvisingTask): string | null {
  const date = field(t.payload, 'sessionDate');
  return typeof date === 'string' && date ? date : null;
}

/**
 * Whether the 1:1 took place: recorded complete, or given a session date. One
 * recorded as missed did not, whatever notes were added ahead of it.
 */
export function wasHeld(t: AdvisingTask): boolean {
  if (t.outcome === 'missed') return false;
  return t.status === 'complete' || sessionDateOf(t) !== null;
}

function notesOf(t: AdvisingTask): Array<{ key: (typeof NOTE_FIELDS)[number]; text: string }> {
  return NOTE_FIELDS.flatMap((key) => {
    const v = field(t.payload, key);
    return typeof v === 'string' && v.trim() !== '' ? [{ key, text: v.trim() }] : [];
  });
}

/**
 * The session whose call notes the Overview links to: the latest 1:1 that was
 * held, so notes added ahead of the next call don't push the last call's
 * aside. Falls back to notes from ahead of a first call.
 */
export function latestNotesSession(
  tasks: AdvisingTask[],
): { period: string; sessionDate: string | null } | null {
  const withNotes = [...tasks].sort(byPeriodDesc).filter((t) => notesOf(t).length > 0);
  const t = withNotes.find(wasHeld) ?? withNotes[0];
  return t ? { period: t.period, sessionDate: sessionDateOf(t) } : null;
}

// -------- End-of-year summary --------

export const NOTE_LABELS: Record<(typeof NOTE_FIELDS)[number], string> = {
  progress: 'Progress and successes',
  challenges: 'Challenges',
  priorities: 'Priority areas before the next 1:1',
  notes: 'Other notes',
};

export interface QiYearSession {
  period: string;
  attendance: 'attended' | 'missed' | 'not_recorded';
  sessionDate: string | null;
  advisorName: string | null;
  attendees: string[];
  notes: Array<{ label: string; text: string }>;
}

export interface QiYearSummary {
  year: number;
  sessions: QiYearSession[];
  /** The plan at the year's last session with aims: open aims, and aims completed that year. */
  aims: QiAim[];
  aimsAsOf: string | null;
}

/** A year's 1:1s, oldest first, for the end-of-year summary. */
export function qiYearSummary(tasks: AdvisingTask[], year: number): QiYearSummary {
  const inYear = tasks
    .filter((t) => t.period.startsWith(`${year}-`))
    .sort((a, b) => a.period.localeCompare(b.period));
  const sessions = inYear.map((t): QiYearSession => {
    const advisor = field(t.payload, 'advisorName');
    const attendees = field(t.payload, 'attendees');
    return {
      period: t.period,
      attendance: t.outcome === 'missed' ? 'missed' : wasHeld(t) ? 'attended' : 'not_recorded',
      sessionDate: sessionDateOf(t),
      advisorName: typeof advisor === 'string' && advisor ? advisor : null,
      attendees: Array.isArray(attendees)
        ? attendees.filter((a): a is string => typeof a === 'string')
        : [],
      notes: notesOf(t).map((n) => ({ label: NOTE_LABELS[n.key], text: n.text })),
    };
  });
  const plan = latestAims(inYear);
  // An aim finished in an earlier year still rides along in the plan.
  const aims = (plan?.aims ?? []).filter((a) => !a.completedOn || a.completedOn >= `${year}-01-01`);
  return { year, sessions, aims, aimsAsOf: plan?.period ?? null };
}
