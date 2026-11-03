/**
 * Helpers for a QI 1:1's call notes, aims and PDSA tests, which live in each
 * 1:1 task's payload (one snapshot per session). Mirrors the backend's
 * qi-advising.ts: the latest session with aims is the current plan, and a new
 * session starts from the one before it.
 */
import type { PdsaDecision, PdsaStage, QiAdvisingContent, QiAim, TaskRow } from './types';

/** Aims open at once; completed aims don't count. Matches the backend. */
export const MAX_ACTIVE_AIMS = 5;
/** All aims on a 1:1, completed ones included. */
export const MAX_AIMS = 15;
export const MAX_TESTS_PER_AIM = 6;

/** The initiative page's QI 1:1 panel, which the Overview links to. */
export const QI_PANEL_ANCHOR = 'qi-1-1s';

export const PDSA_STAGES: PdsaStage[] = ['plan', 'do', 'study', 'act'];
export const STAGE_LABEL: Record<PdsaStage, string> = {
  plan: 'Plan',
  do: 'Do',
  study: 'Study',
  act: 'Act',
};
export const DECISIONS: PdsaDecision[] = ['adopt', 'adapt', 'abandon'];
export const DECISION_LABEL: Record<PdsaDecision, string> = {
  adopt: 'Adopt',
  adapt: 'Adapt',
  abandon: 'Abandon',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function aimsOf(payload: TaskRow['payload']): QiAim[] {
  const aims = payload?.['aims'];
  return Array.isArray(aims) ? (aims as QiAim[]) : [];
}

export function advisingContentOf(payload: TaskRow['payload']): QiAdvisingContent {
  return {
    progress: str(payload?.['progress']),
    challenges: str(payload?.['challenges']),
    priorities: str(payload?.['priorities']),
    notes: str(payload?.['notes']),
    aims: aimsOf(payload),
  };
}

function advisingTasks(tasks: TaskRow[], enrollmentId: string): TaskRow[] {
  return tasks
    .filter((t) => t.enrollmentId === enrollmentId && t.template.taskType === 'qi_advising')
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** The most recent session's aims, before `beforePeriod` when given. */
export function latestAims(
  tasks: TaskRow[],
  enrollmentId: string,
  beforePeriod?: string,
): { aims: QiAim[]; period: string } | null {
  const rows = advisingTasks(tasks, enrollmentId).reverse();
  for (const t of rows) {
    if (beforePeriod !== undefined && t.period >= beforePeriod) continue;
    const aims = aimsOf(t.payload);
    if (aims.length > 0) return { aims, period: t.period };
  }
  return null;
}

/** The date the session before `period` set for this one, if any. */
export function scheduledDateFor(
  tasks: TaskRow[],
  enrollmentId: string,
  period: string,
): string | null {
  const rows = advisingTasks(tasks, enrollmentId).reverse();
  for (const t of rows) {
    if (t.period >= period) continue;
    const next = t.payload?.['nextSessionOn'];
    if (typeof next === 'string' && next) return next;
  }
  return null;
}

const NOTE_KEYS = ['progress', 'challenges', 'priorities', 'notes'] as const;

export function hasCallNotes(payload: TaskRow['payload']): boolean {
  return NOTE_KEYS.some((k) => (str(payload?.[k]) ?? '').trim() !== '');
}

/** Whether CPCQC has recorded the 1:1 (attended or missed), or given it a session date. */
export function wasRecorded(t: TaskRow): boolean {
  return t.status === 'complete' || !!str(t.payload?.['sessionDate']);
}

/**
 * Whether the 1:1 took place. One recorded as missed did not, whatever notes
 * were added ahead of it. Matches the backend.
 */
export function wasHeld(t: TaskRow): boolean {
  return t.outcome !== 'missed' && wasRecorded(t);
}

/** The 1:1s with call notes, newest first. */
export function sessionsWithNotes(tasks: TaskRow[], enrollmentId: string): TaskRow[] {
  return advisingTasks(tasks, enrollmentId).reverse().filter((t) => hasCallNotes(t.payload));
}

/** Today as YYYY-MM-DD, in the browser's time zone. */
export function todayIso(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * The next 1:1 date set at the most recent session that set one, while it is
 * still ahead. Matches the backend's, which the Overview card uses.
 */
export function nextSessionOn(
  tasks: TaskRow[],
  enrollmentId: string,
  today = todayIso(),
): string | null {
  for (const t of advisingTasks(tasks, enrollmentId).reverse()) {
    const next = str(t.payload?.['nextSessionOn']);
    if (next) return next >= today ? next : null;
  }
  return null;
}

/**
 * The 1:1 to work in now: the first not yet recorded, else the latest. One
 * whose quarter has ended with no date still ahead, as when the team missed
 * it and it hasn't been recorded, doesn't hold up the quarters after it.
 */
export function currentAdvisingTask(
  tasks: TaskRow[],
  enrollmentId: string,
  today = todayIso(),
): TaskRow | null {
  const rows = advisingTasks(tasks, enrollmentId);
  const open = rows.filter((t) => t.status !== 'complete');
  const stillAhead = (t: TaskRow) =>
    !t.dueOn ||
    t.dueOn >= today ||
    (scheduledDateFor(tasks, enrollmentId, t.period) ?? '') >= today;
  return open.find(stillAhead) ?? open[open.length - 1] ?? rows[rows.length - 1] ?? null;
}

/** Earlier 1:1s still not recorded, which `currentAdvisingTask` passed over. */
export function unrecordedBefore(tasks: TaskRow[], current: TaskRow): TaskRow[] {
  return advisingTasks(tasks, current.enrollmentId).filter(
    (t) => t.period < current.period && t.status !== 'complete',
  );
}

/**
 * Trim the editor's content for saving: drops tests with no change and aims
 * left completely blank. Returns an error instead when an aim has tests but no
 * statement, which the server would refuse.
 */
export function cleanAdvisingContent(
  c: QiAdvisingContent,
): { content: QiAdvisingContent } | { error: string } {
  const aims: QiAim[] = [];
  for (const a of c.aims ?? []) {
    const tests = a.tests
      .map((t) => ({
        change: t.change.trim(),
        stage: t.stage,
        ...(t.learning?.trim() ? { learning: t.learning.trim() } : {}),
        ...(t.stage === 'act' && t.decision ? { decision: t.decision } : {}),
      }))
      .filter((t) => t.change);
    const statement = a.statement.trim();
    if (!statement && tests.length === 0) continue;
    if (!statement) return { error: 'Each aim needs a statement before its tests can be saved.' };
    aims.push({ statement, tests, ...(a.completedOn ? { completedOn: a.completedOn } : {}) });
  }
  if (aims.filter((a) => !a.completedOn).length > MAX_ACTIVE_AIMS) {
    return {
      error: `Up to ${MAX_ACTIVE_AIMS} aims can be open at once. Mark one complete to add another.`,
    };
  }
  return {
    content: {
      progress: c.progress?.trim() ?? '',
      challenges: c.challenges?.trim() ?? '',
      priorities: c.priorities?.trim() ?? '',
      ...(c.notes !== undefined ? { notes: c.notes.trim() } : {}),
      aims,
    },
  };
}
