'use client';

/**
 * Hospital-user view of a task — read-only status / due / type info, plus an
 * editable Notes field. The full Manage Task modal (status changes, payload
 * fields, etc.) is staff-only because this tracker is the legal CDPHE
 * reporting surface; PMs own the data.
 *
 * Hits PATCH /tasks/:id/note (string saves; null clears). Same staffNote
 * column the staff Manage modal uses, so a PM can see the hospital's comment
 * and vice versa.
 *
 * A QI 1:1 also shows the session CPCQC recorded and lets the hospital edit
 * the call notes and its aims and PDSA tests (PATCH /tasks/:id/advising),
 * which the advisor sees in the same task.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { QiAdvisingContent, QiAim, TaskRow } from '@/lib/types';
import { TaskStatusPill } from './status-pill';
import { QiAdvisingEditor } from './qi-advising-editor';
import { QiSummaryDownload } from './qi-summary-download';
import { fmtDate, fmtPeriod, TASK_TYPE_LABEL } from '@/lib/format';
import { advisingContentOf, cleanAdvisingContent } from '@/lib/qi-advising';

interface TaskCommentModalProps {
  task: TaskRow;
  onClose: () => void;
  onUpdated: (updated: TaskRow) => void;
  /** QI 1:1s: the last session's aims, carried over when this one has none yet. */
  previousAims?: { aims: QiAim[]; period: string } | null;
  /** QI 1:1s: the date the previous session set for this one. */
  scheduledOn?: string | null;
}

export function TaskCommentModal({
  task,
  onClose,
  onUpdated,
  previousAims,
  scheduledOn,
}: TaskCommentModalProps) {
  const [notes, setNotes] = useState(() => task.staffNote ?? '');
  const isAdvising = task.template.taskType === 'qi_advising';
  const carriedAims =
    isAdvising && (advisingContentOf(task.payload).aims ?? []).length === 0 && previousAims
      ? previousAims
      : null;
  const [advising, setAdvising] = useState<QiAdvisingContent>(() => {
    const content = advisingContentOf(task.payload);
    return carriedAims ? { ...content, aims: carriedAims.aims } : content;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const cleaned = isAdvising ? cleanAdvisingContent(advising) : null;
    if (cleaned && 'error' in cleaned) {
      setError(cleaned.error);
      return;
    }
    setSubmitting(true);
    try {
      let updated: TaskRow | null = null;
      if (cleaned) {
        updated = (await api.patch<{ task: TaskRow }>(`/tasks/${task.id}/advising`, cleaned.content)).task;
      }
      const trimmed = notes.trim();
      if (!isAdvising || trimmed !== (task.staffNote ?? '').trim()) {
        updated = (
          await api.patch<{ task: TaskRow }>(`/tasks/${task.id}/note`, {
            // Null explicitly clears the persisted note; the backend distinguishes
            // null from undefined to honor this. See setTaskNote() in tasks.service.
            staffNote: trimmed === '' ? null : trimmed,
          })
        ).task;
      }
      if (updated) onUpdated(updated);
      else onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your changes.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-comment-title"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl bg-white shadow-card ${
          isAdvising ? 'max-w-3xl' : 'max-w-xl'
        }`}
      >
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2
              id="task-comment-title"
              className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark"
            >
              {task.template.name}
            </h2>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
              {TASK_TYPE_LABEL[task.template.taskType]} · {fmtPeriod(task.period)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 px-6 pb-5 pt-4">
          <div className="rounded-xl bg-cpcqc-cream-dark/30 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
            {isAdvising ? (
              <p>
                <strong>Your QI advisor records the 1:1 itself.</strong> You can update the
                call notes and your aims and PDSA tests here at any time; your advisor sees
                the same record.
              </p>
            ) : (
              <p>
                <strong>Tasks are managed by CPCQC.</strong> If something needs to
                change here (e.g. you attended a meeting that's marked missed),
                leave a comment below and your PM will follow up.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                Due
              </div>
              <div className="mt-0.5 text-cpcqc-purple-dark">{fmtDate(task.dueOn)}</div>
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                Status
              </div>
              <div className="mt-0.5">
                <TaskStatusPill status={task.status} outcome={task.outcome} taskType={task.template.taskType} />
              </div>
            </div>
          </div>

          {isAdvising && <SessionDetails task={task} scheduledOn={scheduledOn ?? null} />}

          <QiSummaryDownload task={task} />

          {isAdvising && (
            <QiAdvisingEditor
              value={advising}
              onChange={setAdvising}
              carriedFrom={carriedAims?.period ?? null}
            />
          )}

          {task.template.knowledgeCenterUrl && (
            <a
              href={task.template.knowledgeCenterUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
            >
              Knowledge Center <ExternalLink size={12} aria-hidden />
            </a>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              {isAdvising ? 'Comments (optional)' : 'Notes / comments'}
            </span>
            <textarea
              rows={isAdvising ? 2 : 5}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={5000}
              placeholder="Add a comment for the CPCQC PM team…"
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
            />
          </label>

          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : isAdvising ? 'Save' : 'Save comment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** What CPCQC recorded about the session; hospitals see it but don't edit it. */
function SessionDetails({ task, scheduledOn }: { task: TaskRow; scheduledOn: string | null }) {
  const p = task.payload ?? {};
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const attendees = Array.isArray(p['attendees']) ? (p['attendees'] as string[]) : [];
  const rows: Array<[string, string]> = [
    [
      'Session date',
      task.outcome === 'missed'
        ? 'Did not attend'
        : str('sessionDate')
          ? fmtDate(str('sessionDate'))
          : scheduledOn
            ? `Scheduled for ${fmtDate(scheduledOn)}`
            : 'Not recorded yet',
    ],
    ['QI advisor', str('advisorName') || '—'],
    ['Attendees', attendees.length ? attendees.join(', ') : '—'],
    ['Next 1:1', str('nextSessionOn') ? fmtDate(str('nextSessionOn')) : 'Not scheduled yet'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">{label}</dt>
          <dd className="mt-0.5 text-cpcqc-purple-dark">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
