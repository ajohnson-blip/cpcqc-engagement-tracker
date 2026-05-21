'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { MyTasksResponse, TaskRow, TaskStatus } from '@/lib/types';
import { TaskTable } from '@/components/task-table';

const STATUS_FILTERS: Array<{ value: TaskStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'not_started', label: 'Not started' },
  { value: 'current_activities', label: 'In progress' },
  { value: 'needs_revision', label: 'Needs revision' },
  { value: 'complete', label: 'Complete' },
];

export default function PortalTasksPage() {
  const [tasks, setTasks] = useState<MyTasksResponse['tasks'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');

  useEffect(() => {
    let cancelled = false;
    api
      .get<MyTasksResponse>('/me/tasks')
      .then((data) => {
        if (!cancelled) setTasks(data.tasks);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo<TaskRow[]>(() => {
    if (!tasks) return [];
    const rows = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
    // Adapt the aggregated shape to the richer TaskRow shape consumed by TaskTable.
    return rows.map((t) => ({
      id: t.id,
      enrollmentId: t.enrollmentId,
      programYear: t.programYear,
      stage: { id: '', code: t.stage.code, name: t.stage.name, sequence: 0 },
      template: {
        id: '',
        name: t.template.name,
        taskType: t.template.taskType,
        period: '',
        periodLabel: null,
        knowledgeCenterUrl: t.template.knowledgeCenterUrl,
        countsTowardRequirement: true,
      },
      period: t.period,
      dueOn: t.dueOn,
      status: t.status,
      completedOn: t.completedOn,
      staffNote: null,
      attachmentUrl: null,
      payload: null,
      updatedAt: '',
    }));
  }, [tasks, filter]);

  const initiativeByEnrollment = useMemo(() => {
    const m = new Map<string, { code: string; name: string }>();
    for (const t of tasks ?? []) m.set(t.enrollmentId, t.initiative);
    return m;
  }, [tasks]);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">My Tasks</h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          All tasks across every initiative you're enrolled in. Sorted by due date.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={
              'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition ' +
              (filter === f.value
                ? 'bg-cpcqc-purple text-white'
                : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10')
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {tasks === null && !error ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : (
        <TaskTable tasks={filtered} showInitiative initiativeByEnrollment={initiativeByEnrollment} />
      )}
    </div>
  );
}
