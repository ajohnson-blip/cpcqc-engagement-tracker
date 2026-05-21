'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, AlertCircle, Inbox, Building2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { StaffOverviewResponse } from '@/lib/types';
import { RequirementStatusPill } from '@/components/status-pill';
import { fmtDate } from '@/lib/format';

export default function StaffOverviewPage() {
  const [data, setData] = useState<StaffOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StaffOverviewResponse>('/staff/overview')
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <div className="space-y-8">
      <header>
        <p className="font-script text-2xl text-cpcqc-purple-dark/80">Good to see you,</p>
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark sm:text-4xl">
          CPCQC Engagement Overview
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          A roll-up across initiatives, sorted to surface what needs attention first.
        </p>
      </header>

      {/* Totals strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={<Building2 size={18} />} label="Hospitals enrolled" value={data.totals.hospitalsEnrolled} />
        <StatCard
          icon={<ChevronRight size={18} />}
          label="Active enrollments"
          value={data.totals.totalEnrollments}
        />
        <StatCard
          icon={<Inbox size={18} />}
          label="Pending interest forms"
          value={data.totals.pendingInterestForms}
          href="/staff/interest-forms"
        />
      </div>

      {/* Per-initiative summary cards */}
      <section>
        <h2 className="mb-3 font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
          By initiative
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {data.initiatives.map((init) => (
            <Link
              key={init.initiativeId}
              href={`/staff/initiatives/${init.code}`}
              className="block rounded-2xl bg-white p-5 shadow-card ring-1 ring-cpcqc-purple-dark/5 transition hover:shadow-lg"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
                    {init.code}
                  </h3>
                  <p className="text-xs text-cpcqc-purple-dark/60">{init.name}</p>
                </div>
                <span className="rounded-full bg-cpcqc-purple/10 px-2.5 py-0.5 text-sm font-bold text-cpcqc-purple">
                  {init.enrolled}
                </span>
              </div>
              <div className="mt-4 space-y-1.5">
                <CountRow color="bg-cpcqc-teal-dark" label="Met" value={init.met} />
                <CountRow color="bg-cpcqc-purple" label="On track" value={init.onTrack} />
                <CountRow color="bg-cpcqc-orange-dark" label="At risk" value={init.atRisk} />
                <CountRow color="bg-cpcqc-pink-dark" label="Not met" value={init.notMet} />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Needs attention list */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <AlertCircle size={18} className="text-cpcqc-pink-dark" aria-hidden />
          <h2 className="font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
            Needs attention
          </h2>
        </div>
        {data.needsAttention.length === 0 ? (
          <div className="rounded-2xl bg-white p-6 text-center text-cpcqc-purple-dark/70 shadow-sm">
            Everything's on track. Nothing flagged right now.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
            <table className="w-full text-left">
              <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                <tr>
                  <th className="px-4 py-3">Hospital</th>
                  <th className="px-4 py-3">Initiative</th>
                  <th className="px-4 py-3">Track</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.needsAttention.map((row) => (
                  <tr key={row.enrollmentId} className="border-t border-cpcqc-purple-dark/10">
                    <td className="px-4 py-3 font-semibold text-cpcqc-purple-dark">
                      {row.hospitalName}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className="rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
                        {row.initiativeCode}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm capitalize text-cpcqc-purple-dark/70">
                      {row.track}
                    </td>
                    <td className="px-4 py-3">
                      {row.compliance && (
                        <RequirementStatusPill status={row.compliance.result.overall} />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/staff/hospitals/${row.hospitalId}`}
                        className="font-semibold text-cpcqc-purple hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending interest forms */}
      {data.pendingInterestForms.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
              Pending interest forms
            </h2>
            <Link
              href="/staff/interest-forms"
              className="text-sm font-semibold text-cpcqc-purple hover:underline"
            >
              See all →
            </Link>
          </div>
          <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
            <table className="w-full text-left">
              <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                <tr>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Facility</th>
                  <th className="px-4 py-3">Submitter</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.pendingInterestForms.map((f) => (
                  <tr key={f.id} className="border-t border-cpcqc-purple-dark/10">
                    <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">{fmtDate(f.createdAt)}</td>
                    <td className="px-4 py-3 font-semibold text-cpcqc-purple-dark">
                      {f.facilityName}
                    </td>
                    <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                      {f.firstName} {f.lastName} · {f.role}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/staff/interest-forms/${f.id}`}
                        className="font-semibold text-cpcqc-purple hover:underline"
                      >
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  href?: string;
}) {
  const inner = (
    <div className="flex items-center justify-between rounded-2xl bg-white p-5 shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">{label}</p>
        <p className="mt-1 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">{value}</p>
      </div>
      <div className="rounded-full bg-cpcqc-purple/10 p-2.5 text-cpcqc-purple">{icon}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition hover:shadow-lg">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function CountRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2 text-cpcqc-purple-dark/80">
        <span className={`h-2.5 w-2.5 rounded-full ${color}`} aria-hidden />
        {label}
      </span>
      <span className="font-rounded font-bold text-cpcqc-purple-dark">{value}</span>
    </div>
  );
}
