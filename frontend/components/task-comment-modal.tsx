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
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { TaskRow } from '@/lib/types';
import { TaskStatusPill } from './status-pill';
import { fmtDate, fmtPeriod, TASK_TYPE_LABEL } from '@/lib/format';

interface TaskCommentModalProps {
  task: TaskRow;
  onClose: () => void;
  onUpdated: (updated: TaskRow) => void;
}

export function TaskCommentModal({ task, onClose, onUpdated }: TaskCommentModalProps) {
  const [notes, setNotes] = useState(() => task.staffNote ?? '');
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
    setSubmitting(true);
    try {
      const trimmed = notes.trim();
      const res = await api.patch<{ task: TaskRow }>(`/tasks/${task.id}/note`, {
        // Null explicitly clears the persisted note; the backend distinguishes
        // null from undefined to honor this. See setTaskNote() in tasks.service.
        staffNote: trimmed === '' ? null : trimmed,
      });
      onUpdated(res.task);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your comment.');
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
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-card">
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
            <p>
              <strong>Tasks are managed by CPCQC.</strong> If something needs to
              change here (e.g. you attended a meeting that's marked missed),
              leave a comment below and your PM will follow up.
            </p>
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
              Notes / comments
            </span>
            <textarea
              rows={5}
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
              {submitting ? 'Saving…' : 'Save comment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
