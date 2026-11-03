'use client';

/**
 * The QI 1:1 summary: when the next 1:1 is, the latest call notes (earlier
 * sessions' folded underneath), and the aims and PDSA tests as they stood at
 * the latest session. The button opens the 1:1 to work in now, in the same
 * window the task list uses, so there is one place the record is edited.
 *
 * Hospitals see it on their initiative page, which the Overview links to as
 * #qi-1-1s; staff see it `embedded` in each enrollment on the hospital page.
 */

import { useEffect, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  QI_PANEL_ANCHOR,
  currentAdvisingTask,
  latestAims,
  nextSessionOn,
  scheduledDateFor,
  sessionsWithNotes,
  unrecordedBefore,
  wasHeld,
  wasRecorded,
} from '@/lib/qi-advising';
import { fmtDate, fmtPeriod } from '@/lib/format';
import type { TaskRow } from '@/lib/types';
import { AimsList } from './qi-advising-editor';
import { ManageTaskModal } from './manage-task-modal';
import { TaskCommentModal } from './task-comment-modal';

const NOTE_LABELS: Array<[key: string, label: string]> = [
  ['progress', 'Progress and successes'],
  ['challenges', 'Challenges'],
  ['priorities', 'Priority areas before the next 1:1'],
  ['notes', 'Other notes'],
];

const H3 = 'font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark/80';

interface Props {
  tasks: TaskRow[];
  enrollmentId: string;
  onTaskUpdated: (updated: TaskRow) => void;
  /** Inside another card (the staff hospital page) rather than a card of its own. */
  embedded?: boolean;
}

export function QiAdvisingPanel({ tasks, enrollmentId, onTaskUpdated, embedded = false }: Props) {
  const { user } = useAuth();
  const isStaff = user?.role === 'cpcqc_staff' || user?.role === 'cpcqc_admin';
  const [openTask, setOpenTask] = useState<TaskRow | null>(null);
  const ref = useRef<HTMLElement>(null);

  // The page loads its tasks before this renders, so the browser's own jump
  // to the #anchor has already been missed.
  useEffect(() => {
    if (!embedded && window.location.hash === `#${QI_PANEL_ANCHOR}`) ref.current?.scrollIntoView();
  }, [embedded]);

  const current = currentAdvisingTask(tasks, enrollmentId);
  if (!current) return null;
  const latest = latestAims(tasks, enrollmentId);
  const nextOn = nextSessionOn(tasks, enrollmentId);
  // Staff are asked to record a 1:1 the panel has moved past.
  const unrecorded = isStaff ? unrecordedBefore(tasks, current) : [];
  // The last call's notes lead; notes added ahead of the next call sit under
  // them rather than pushing them aside. A missed 1:1's notes fold away with
  // the earlier ones.
  const withNotes = sessionsWithNotes(tasks, enrollmentId);
  const latestNotes = withNotes.find(wasHeld);
  const aheadNotes = withNotes.filter((t) => !wasRecorded(t));
  const earlierNotes = withNotes.filter((t) => t !== latestNotes && wasRecorded(t));
  const close = () => setOpenTask(null);
  const updated = (t: TaskRow) => {
    setOpenTask(null);
    onTaskUpdated(t);
  };

  return (
    <section
      id={embedded ? undefined : QI_PANEL_ANCHOR}
      ref={ref}
      className={
        embedded
          ? 'mt-5 rounded-xl border border-cpcqc-purple-dark/10 p-5'
          : 'mb-6 scroll-mt-6 rounded-2xl bg-white p-6 shadow-card'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            className={`font-rounded font-extrabold text-cpcqc-purple-dark ${embedded ? 'text-base' : 'text-lg'}`}
          >
            QI advising 1:1s
          </h2>
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-cpcqc-purple-dark/70">
            <CalendarDays size={14} aria-hidden />
            {nextOn ? (
              <>
                Next 1:1:{' '}
                <span className="font-semibold text-cpcqc-purple-dark">
                  {fmtDate(nextOn, 'EEE, MMM d, yyyy')}
                </span>
              </>
            ) : (
              'Next 1:1 not scheduled yet'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpenTask(current)}
          className="rounded-full border border-cpcqc-purple/30 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple transition hover:bg-cpcqc-purple hover:text-white"
        >
          Update in the {fmtPeriod(current.period)} 1:1
        </button>
      </div>

      {unrecorded.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-cpcqc-orange/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
          <span>Not recorded yet:</span>
          {unrecorded.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setOpenTask(t)}
              className="font-semibold text-cpcqc-purple underline-offset-2 hover:underline"
            >
              {fmtPeriod(t.period)} 1:1
            </button>
          ))}
        </p>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className={H3}>Latest notes</h3>
          {latestNotes || aheadNotes.length > 0 || earlierNotes.length > 0 ? (
            <>
              {latestNotes && <SessionNotes task={latestNotes} />}
              {aheadNotes.map((t) => (
                <div key={t.id} className="mt-4">
                  <SessionNotes task={t} />
                </div>
              ))}
              {earlierNotes.length > 0 && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70 hover:text-cpcqc-purple">
                    Earlier 1:1 notes ({earlierNotes.length})
                  </summary>
                  <div className="mt-2 space-y-4 border-l-2 border-cpcqc-purple-dark/10 pl-3">
                    {earlierNotes.map((t) => (
                      <SessionNotes key={t.id} task={t} />
                    ))}
                  </div>
                </details>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-cpcqc-purple-dark/60">No notes recorded yet.</p>
          )}
        </div>

        <div>
          <h3 className={H3}>Aims and PDSA tests</h3>
          <div className="mt-2">
            <AimsList aims={latest?.aims ?? []} />
            {latest && (
              <p className="mt-3 text-xs text-cpcqc-purple-dark/50">
                As of the {fmtPeriod(latest.period)} 1:1.
              </p>
            )}
          </div>
        </div>
      </div>

      {openTask &&
        (isStaff ? (
          <ManageTaskModal
            key={openTask.id}
            task={openTask}
            previousAims={latestAims(tasks, enrollmentId, openTask.period)}
            scheduledOn={scheduledDateFor(tasks, enrollmentId, openTask.period)}
            onClose={close}
            onUpdated={updated}
          />
        ) : (
          <TaskCommentModal
            key={openTask.id}
            task={openTask}
            previousAims={latestAims(tasks, enrollmentId, openTask.period)}
            scheduledOn={scheduledDateFor(tasks, enrollmentId, openTask.period)}
            onClose={close}
            onUpdated={updated}
          />
        ))}
    </section>
  );
}

/** One session's call notes, headed by which 1:1 they're from. */
function SessionNotes({ task }: { task: TaskRow }) {
  const p = task.payload ?? {};
  const sessionDate = typeof p['sessionDate'] === 'string' ? (p['sessionDate'] as string) : '';
  return (
    <div className="mt-2">
      <p className="text-xs text-cpcqc-purple-dark/60">
        {fmtPeriod(task.period)} 1:1 ·{' '}
        {task.outcome === 'missed'
          ? 'did not attend'
          : sessionDate
            ? fmtDate(sessionDate)
            : 'added ahead of the call'}
      </p>
      <dl className="mt-1.5 space-y-2">
        {NOTE_LABELS.map(([key, label]) => {
          const text = typeof p[key] === 'string' ? (p[key] as string).trim() : '';
          if (!text) return null;
          return (
            <div key={key}>
              <dt className="text-xs font-bold text-cpcqc-purple-dark/70">{label}</dt>
              <dd className="whitespace-pre-line text-sm text-cpcqc-purple-dark">{text}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
