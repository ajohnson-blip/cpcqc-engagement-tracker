'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, Mail, Phone, MapPin, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '@/lib/api';
import type { HospitalDetailResponse, TaskRow } from '@/lib/types';
import { ComplianceTile } from '@/components/compliance-tile';
import { RequirementStatusPill } from '@/components/status-pill';
import { TaskTable } from '@/components/task-table';
import { fmtDate } from '@/lib/format';

export default function StaffHospitalDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<HospitalDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lazy-loaded task lists, keyed by enrollmentId. Loaded on first expand;
  // cached after that. Null = not loaded yet; [] = loaded, no tasks.
  const [tasksByEnrollment, setTasksByEnrollment] = useState<Record<string, TaskRow[] | null>>({});
  const [expandedEnrollment, setExpandedEnrollment] = useState<string | null>(null);
  const [showWithdrawn, setShowWithdrawn] = useState(false);

  function toggleEnrollmentTasks(enrollmentId: string) {
    if (expandedEnrollment === enrollmentId) {
      setExpandedEnrollment(null);
      return;
    }
    setExpandedEnrollment(enrollmentId);
    if (tasksByEnrollment[enrollmentId] !== undefined) return; // already loading/loaded
    setTasksByEnrollment((prev) => ({ ...prev, [enrollmentId]: null }));
    api
      .get<{ tasks: TaskRow[] }>(`/tasks/enrollment/${enrollmentId}`)
      .then((res) =>
        setTasksByEnrollment((prev) => ({ ...prev, [enrollmentId]: res.tasks })),
      )
      .catch((err: Error) => setError(err.message));
  }

  function handleTaskUpdated(enrollmentId: string, updated: TaskRow) {
    setTasksByEnrollment((prev) => {
      const list = prev[enrollmentId];
      if (!list) return prev;
      return { ...prev, [enrollmentId]: list.map((t) => (t.id === updated.id ? updated : t)) };
    });
    // Refresh hospital detail so the compliance tiles reflect the new state.
    void api
      .get<HospitalDetailResponse>(`/staff/hospitals/${params.id}`)
      .then((d) => setData(d));
  }

  useEffect(() => {
    let cancelled = false;
    api
      .get<HospitalDetailResponse>(`/staff/hospitals/${params.id}`)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
        Loading…
      </div>
    );
  }

  const { hospital, enrollments, staffMembers, recentAudit } = data;
  const addressLine = [
    hospital.addressLine1,
    hospital.addressLine2,
    [hospital.city, hospital.state, hospital.postalCode].filter(Boolean).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-8">
      <Link
        href="/staff"
        className="inline-flex items-center gap-1 text-sm font-semibold text-cpcqc-purple-dark/70 hover:text-cpcqc-purple"
      >
        <ChevronLeft size={16} aria-hidden /> Overview
      </Link>

      {/* Hospital header */}
      <header className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="p-6">
          <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
            {hospital.name}
          </h1>
          <div className="mt-3 grid grid-cols-1 gap-3 text-sm text-cpcqc-purple-dark/80 sm:grid-cols-2">
            {addressLine && (
              <div className="flex items-start gap-2">
                <MapPin size={16} aria-hidden className="mt-0.5 text-cpcqc-purple-dark/60" />
                <span>{addressLine}</span>
              </div>
            )}
            {hospital.defaultContactName && (
              <div className="flex items-start gap-2">
                <Mail size={16} aria-hidden className="mt-0.5 text-cpcqc-purple-dark/60" />
                <span>
                  {hospital.defaultContactName}
                  {hospital.defaultContactEmail && (
                    <>
                      {' · '}
                      <a
                        href={`mailto:${hospital.defaultContactEmail}`}
                        className="text-cpcqc-purple hover:underline"
                      >
                        {hospital.defaultContactEmail}
                      </a>
                    </>
                  )}
                </span>
              </div>
            )}
            {hospital.region && (
              <div className="flex items-start gap-2">
                <FileText size={16} aria-hidden className="mt-0.5 text-cpcqc-purple-dark/60" />
                <span>Region: {hospital.region}</span>
              </div>
            )}
            {hospital.cmsId && (
              <div className="flex items-start gap-2">
                <FileText size={16} aria-hidden className="mt-0.5 text-cpcqc-purple-dark/60" />
                <span>CMS ID: {hospital.cmsId}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Enrollments — withdrawn ones hidden by default so historical or
          mis-classified records don't clutter the current view (e.g., a
          hospital reclassified from SOAR sustainability to SOAR active still
          carries the old withdrawn enrollment for the audit trail). */}
      {(() => {
        const visibleEnrollments = showWithdrawn
          ? enrollments
          : enrollments.filter((e) => e.status !== 'withdrawn');
        const withdrawnCount = enrollments.length - enrollments.filter((e) => e.status !== 'withdrawn').length;
        return (
      <section className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
            Enrollments
          </h2>
          {withdrawnCount > 0 && (
            <button
              type="button"
              onClick={() => setShowWithdrawn((v) => !v)}
              className="rounded-full border border-cpcqc-purple-dark/15 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
            >
              {showWithdrawn
                ? `Hide ${withdrawnCount} withdrawn`
                : `Show ${withdrawnCount} withdrawn`}
            </button>
          )}
        </div>
        {visibleEnrollments.length === 0 ? (
          <div className="rounded-2xl bg-white p-6 text-center text-cpcqc-purple-dark/70 shadow-sm">
            {enrollments.length === 0
              ? 'No enrollments yet.'
              : 'No active enrollments. Click "Show withdrawn" above to see historical ones.'}
          </div>
        ) : (
          visibleEnrollments.map((e) => (
            <div
              key={e.enrollmentId}
              className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5"
            >
              <div className="h-1 w-full bg-cpcqc-purple/20" />
              <div className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      {e.initiative?.emoji && <span aria-hidden className="text-xl">{e.initiative.emoji}</span>}
                      <h3 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
                        {e.initiative?.name ?? '(Unknown initiative)'}
                      </h3>
                    </div>
                    <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
                      {e.cohort?.label}
                      {e.cohort?.track === 'sustainability' && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-cpcqc-teal/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cpcqc-teal-dark">
                          Sustainability
                        </span>
                      )}
                    </p>
                    {e.currentStage && (
                      <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
                        Current stage:{' '}
                        <span className="font-semibold text-cpcqc-purple-dark">
                          {e.currentStage.name}
                        </span>
                      </p>
                    )}
                    <p className="mt-1 text-xs text-cpcqc-purple-dark/60">
                      Enrolled {fmtDate(e.enrolledOn)}
                      {e.withdrawnOn ? ` · Withdrawn ${fmtDate(e.withdrawnOn)}` : ''}
                    </p>
                  </div>
                  <Link
                    href={`/staff/initiatives/${e.initiative?.code ?? ''}`}
                    className="rounded-full border border-cpcqc-purple/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white"
                  >
                    Cohort list →
                  </Link>
                </div>

                <div className="mt-5 space-y-4">
                  {e.programYears.map((py) => (
                    <div key={py.programYearId} className="rounded-xl bg-cpcqc-cream-dark/30 p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
                          Program year {py.programYear}
                        </span>
                        <RequirementStatusPill status={py.result.overall} />
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <ComplianceTile label="Enrollment" result={py.result.enrollment} boolean />
                        <ComplianceTile label="Meetings" result={py.result.meetings} />
                        <ComplianceTile label="QI Advising" result={py.result.advising} />
                        <ComplianceTile label="Data Submissions" result={py.result.dataSubmissions} />
                        {py.result.assessments && (
                          <ComplianceTile label="Readiness Assessments" result={py.result.assessments} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Tasks (lazy-loaded inline expand) */}
                <div className="mt-5">
                  <button
                    type="button"
                    onClick={() => toggleEnrollmentTasks(e.enrollmentId)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple/30 px-3.5 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white"
                  >
                    {expandedEnrollment === e.enrollmentId ? (
                      <>
                        <ChevronUp size={14} aria-hidden /> Hide tasks
                      </>
                    ) : (
                      <>
                        <ChevronDown size={14} aria-hidden /> Manage tasks
                      </>
                    )}
                  </button>

                  {expandedEnrollment === e.enrollmentId && (
                    <div className="mt-4">
                      {tasksByEnrollment[e.enrollmentId] === null ? (
                        <div className="rounded-xl bg-white p-6 text-center text-sm text-cpcqc-purple-dark/60 shadow-sm">
                          Loading tasks…
                        </div>
                      ) : tasksByEnrollment[e.enrollmentId]?.length === 0 ? (
                        <div className="rounded-xl bg-white p-6 text-center text-sm text-cpcqc-purple-dark/60 shadow-sm">
                          No tasks for this enrollment yet.
                        </div>
                      ) : (
                        <TaskTable
                          tasks={tasksByEnrollment[e.enrollmentId] ?? []}
                          onTaskUpdated={(updated) => handleTaskUpdated(e.enrollmentId, updated)}
                          groupByStage
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </section>
        );
      })()}

      {/* Staff roster */}
      {staffMembers.length > 0 && (
        <section>
          <h2 className="mb-3 font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
            Hospital roster
          </h2>
          <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
            <table className="w-full text-left">
              <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Contact</th>
                </tr>
              </thead>
              <tbody>
                {staffMembers.map((s) => (
                  <tr key={s.id} className="border-t border-cpcqc-purple-dark/10">
                    <td className="px-4 py-3 font-semibold text-cpcqc-purple-dark">{s.name}</td>
                    <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">{s.role ?? '—'}</td>
                    <td className="px-4 py-3 text-sm">
                      {s.email && (
                        <a
                          href={`mailto:${s.email}`}
                          className="inline-flex items-center gap-1 text-cpcqc-purple hover:underline"
                        >
                          <Mail size={12} aria-hidden /> {s.email}
                        </a>
                      )}
                      {s.phone && (
                        <span className="ml-3 inline-flex items-center gap-1 text-cpcqc-purple-dark/80">
                          <Phone size={12} aria-hidden /> {s.phone}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent audit log */}
      {recentAudit.length > 0 && (
        <section>
          <h2 className="mb-3 font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
            Recent activity
          </h2>
          <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
            <ul className="divide-y divide-cpcqc-purple-dark/10">
              {recentAudit.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                  <div>
                    <span className="font-rounded font-bold uppercase tracking-wide text-cpcqc-purple-dark">
                      {a.action.replace(/\./g, ' › ')}
                    </span>
                    {a.note && <p className="mt-0.5 text-cpcqc-purple-dark/70">{a.note}</p>}
                  </div>
                  <span className="whitespace-nowrap text-xs text-cpcqc-purple-dark/60">
                    {fmtDate(a.createdAt, 'MMM d, yyyy · h:mm a')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
