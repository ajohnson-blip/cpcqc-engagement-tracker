'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { api } from '@/lib/api';
import type { TaskRow, MyEnrollment } from '@/lib/types';
import { TaskTable } from '@/components/task-table';
import { RequirementStatusPill } from '@/components/status-pill';

export default function EnrollmentDetailPage() {
  const params = useParams<{ id: string }>();
  const enrollmentId = params.id;
  const [enrollment, setEnrollment] = useState<MyEnrollment | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.get<{ enrollments: MyEnrollment[] }>('/me/enrollments'),
      api.get<{ tasks: TaskRow[] }>(`/tasks/enrollment/${enrollmentId}`),
    ])
      .then(([enrollmentsRes, tasksRes]) => {
        if (cancelled) return;
        setEnrollment(enrollmentsRes.enrollments.find((e) => e.enrollmentId === enrollmentId) ?? null);
        setTasks(tasksRes.tasks);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollmentId]);

  function handleUpdated(updated: TaskRow) {
    setTasks((prev) => (prev ? prev.map((t) => (t.id === updated.id ? updated : t)) : prev));
    // Refresh enrollment to pull updated compliance + possibly advanced stage
    void api
      .get<{ enrollments: MyEnrollment[] }>('/me/enrollments')
      .then((r) =>
        setEnrollment(r.enrollments.find((e) => e.enrollmentId === enrollmentId) ?? null),
      );
  }

  if (error) {
    return (
      <div className="rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
        {error}
      </div>
    );
  }

  if (!enrollment || !tasks) {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
        Loading…
      </div>
    );
  }

  const compliance = enrollment.currentProgramYear;

  return (
    <div>
      <Link
        href="/portal"
        className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-cpcqc-purple-dark/70 hover:text-cpcqc-purple"
      >
        <ChevronLeft size={16} aria-hidden /> Back to overview
      </Link>

      <header className="mb-6 rounded-2xl bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              {enrollment.initiative?.emoji && (
                <span aria-hidden className="text-2xl">{enrollment.initiative.emoji}</span>
              )}
              <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
                {enrollment.initiative?.name}
              </h1>
            </div>
            <p className="mt-1 text-cpcqc-purple-dark/70">{enrollment.cohort?.label}</p>
            {enrollment.currentStage && (
              <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
                Current stage:{' '}
                <span className="font-semibold text-cpcqc-purple-dark">
                  {enrollment.currentStage.name}
                </span>
              </p>
            )}
          </div>
          {compliance && (
            <div className="text-right">
              <p className="text-xs uppercase tracking-wide text-cpcqc-purple-dark/60">
                Program year {compliance.programYear}
              </p>
              <div className="mt-1">
                <RequirementStatusPill status={compliance.result.overall} />
              </div>
            </div>
          )}
        </div>
      </header>

      <TaskTable tasks={tasks} onTaskUpdated={handleUpdated} groupByStage />
    </div>
  );
}
