'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { MyTasksResponse, TaskRow, TaskStatus } from '@/lib/types';
import { TaskTable } from '@/components/task-table';
import { useAuth } from '@/lib/auth-context';

const STATUS_FILTERS: Array<{ value: TaskStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'not_started', label: 'Not started' },
  { value: 'current_activities', label: 'In progress' },
  // One status, two names: data submissions display as "Incomplete", every
  // other task type as "Needs revision". The filter names both so it is not
  // read as covering only half of what it selects.
  { value: 'needs_revision', label: 'Needs revision / Incomplete' },
  { value: 'complete', label: 'Complete' },
];

// Stable display order for the initiative pills — same order CPCQC uses
// elsewhere (matches the staff header, reports, etc.). Pills are filtered
// down to only the initiatives the signed-in hospital actually has tasks
// for, so a TTT-only hospital won't see SPARK/SOAR/NEST pills.
const INITIATIVE_ORDER = ['TTT', 'SPARK', 'SOAR', 'NEST'] as const;

export default function PortalTasksPage() {
  const { activeHospitalId } = useAuth();
  const [tasks, setTasks] = useState<MyTasksResponse['tasks'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [initiativeFilter, setInitiativeFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    api
      .get<MyTasksResponse>(
        `/me/tasks${activeHospitalId ? `?hospitalId=${activeHospitalId}` : ''}`,
      )
      .then((data) => {
        if (!cancelled) setTasks(data.tasks);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [activeHospitalId]);

  // The set of initiatives the signed-in user actually has tasks for —
  // drives which initiative pills get rendered. Computed from the loaded
  // task list rather than a separate enrollments call so the UI is always
  // consistent with what the table can possibly show.
  const availableInitiatives = useMemo<Array<{ code: string; name: string }>>(() => {
    if (!tasks) return [];
    const byCode = new Map<string, string>();
    for (const t of tasks) byCode.set(t.initiative.code, t.initiative.name);
    return INITIATIVE_ORDER
      .filter((code) => byCode.has(code))
      .map((code) => ({ code, name: byCode.get(code)! }));
  }, [tasks]);

  const filtered = useMemo<TaskRow[]>(() => {
    if (!tasks) return [];
    let rows = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
    if (initiativeFilter !== 'all') {
      rows = rows.filter((t) => t.initiative.code === initiativeFilter);
    }
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
      outcome: t.outcome,
      completedOn: t.completedOn,
      staffNote: null,
      attachmentUrl: null,
      payload: null,
      updatedAt: '',
    }));
  }, [tasks, filter, initiativeFilter]);

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
          Use the filters below to narrow by initiative or status.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {availableInitiatives.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
            Initiative
          </span>
          <button
            type="button"
            onClick={() => setInitiativeFilter('all')}
            className={
              'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition ' +
              (initiativeFilter === 'all'
                ? 'bg-cpcqc-purple text-white'
                : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10')
            }
          >
            All
          </button>
          {availableInitiatives.map((init) => (
            <button
              key={init.code}
              type="button"
              onClick={() => setInitiativeFilter(init.code)}
              className={
                'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition ' +
                (initiativeFilter === init.code
                  ? 'bg-cpcqc-purple text-white'
                  : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10')
              }
            >
              {init.code}
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
          Status
        </span>
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
