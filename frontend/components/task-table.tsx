'use client';

import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { TaskStatusPill } from './status-pill';
import { ManageTaskModal } from './manage-task-modal';
import { TaskCommentModal } from './task-comment-modal';
import { fmtDate, fmtPeriod, TASK_TYPE_LABEL } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import type { TaskRow } from '@/lib/types';

interface TaskTableProps {
  tasks: TaskRow[];
  /** Called after a task is successfully managed; parent should refresh data. */
  onTaskUpdated?: (updated: TaskRow) => void;
  /** When true, group rows by stage with a header per group. */
  groupByStage?: boolean;
  /** When true, also show the initiative column (cross-enrollment views). */
  showInitiative?: boolean;
  initiativeByEnrollment?: Map<string, { code: string; name: string }>;
}

export function TaskTable({
  tasks,
  onTaskUpdated,
  groupByStage = false,
  showInitiative = false,
  initiativeByEnrollment,
}: TaskTableProps) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) ?? null : null;
  // Hospital users (hospital_user, hospital_admin) get a read-only view with
  // a comment box; CPCQC staff (cpcqc_staff, cpcqc_admin) get the full
  // Manage Task modal. The button label flips with the role for clarity.
  const { user } = useAuth();
  const isStaff = user?.role === 'cpcqc_staff' || user?.role === 'cpcqc_admin';

  const grouped = useMemo(() => {
    if (!groupByStage) return null;
    const groups = new Map<string, { stage: TaskRow['stage']; rows: TaskRow[] }>();
    for (const t of tasks) {
      const key = `${t.stage.sequence}-${t.stage.code}`;
      if (!groups.has(key)) groups.set(key, { stage: t.stage, rows: [] });
      groups.get(key)!.rows.push(t);
    }
    return Array.from(groups.values()).sort((a, b) => a.stage.sequence - b.stage.sequence);
  }, [tasks, groupByStage]);

  function renderRow(task: TaskRow) {
    const initiative = initiativeByEnrollment?.get(task.enrollmentId);
    // Migration 0015 backfilled the legacy payload.notes location into
    // staff_note, so staff_note is now the canonical source — no fallback
    // needed. (Falling back to payload.notes would cause cleared notes to
    // resurface from the stale JSONB sub-field.)
    const noteText = task.staffNote;
    return (
      <tr key={task.id} className="border-t border-cpcqc-purple-dark/10">
        {showInitiative && (
          <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
            {initiative ? (
              <span className="rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
                {initiative.code}
              </span>
            ) : (
              '—'
            )}
          </td>
        )}
        <td className="px-4 py-3">
          <div className="font-semibold text-cpcqc-purple-dark">{task.template.name}</div>
          <div className="text-xs text-cpcqc-purple-dark/60">
            {TASK_TYPE_LABEL[task.template.taskType]} · {fmtPeriod(task.period)}
          </div>
        </td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">{fmtDate(task.dueOn)}</td>
        <td className="px-4 py-3">
          <TaskStatusPill status={task.status} outcome={task.outcome} />
        </td>
        <td className="max-w-[14rem] px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          {noteText ? (
            // line-clamp-2 + the native title tooltip lets a user skim the
            // first ~2 lines and hover for the full text without leaving the
            // table. Modal still owns the full edit surface.
            <span
              title={noteText}
              className="line-clamp-2 cursor-help break-words leading-snug"
            >
              {noteText}
            </span>
          ) : (
            <span className="text-cpcqc-purple-dark/40">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <div className="inline-flex items-center gap-2">
            {task.template.knowledgeCenterUrl && (
              <a
                href={task.template.knowledgeCenterUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
                title="Knowledge Center"
              >
                Info <ExternalLink size={12} aria-hidden />
              </a>
            )}
            <button
              type="button"
              onClick={() => setOpenTaskId(task.id)}
              className="rounded-full bg-cpcqc-purple px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
            >
              {isStaff ? 'Manage task' : 'View / comment'}
            </button>
          </div>
        </td>
      </tr>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
        No tasks to show.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <table className="w-full text-left">
          <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
            <tr>
              {showInitiative && <th className="px-4 py-3">Initiative</th>}
              <th className="px-4 py-3">Task</th>
              <th className="px-4 py-3">Due</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Notes</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grouped
              ? grouped.flatMap((g) => [
                  <tr key={`group-${g.stage.code}`} className="bg-cpcqc-cream-dark/30">
                    <td
                      colSpan={showInitiative ? 6 : 5}
                      className="px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark"
                    >
                      {g.stage.code} {g.stage.name}
                    </td>
                  </tr>,
                  ...g.rows.map(renderRow),
                ])
              : tasks.map(renderRow)}
          </tbody>
        </table>
      </div>
      {openTask && (isStaff ? (
        <ManageTaskModal
          task={openTask}
          onClose={() => setOpenTaskId(null)}
          onUpdated={(t) => {
            setOpenTaskId(null);
            onTaskUpdated?.(t);
          }}
        />
      ) : (
        <TaskCommentModal
          task={openTask}
          onClose={() => setOpenTaskId(null)}
          onUpdated={(t) => {
            setOpenTaskId(null);
            onTaskUpdated?.(t);
          }}
        />
      ))}
    </>
  );
}
