'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, LayoutGrid } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { RequirementStatusPill } from '@/components/status-pill';
import type { SystemRollupResponse, RollupCell } from '@/lib/types';

/** If every hospital name shares a first word (e.g. "UCHealth …"), use it as the
 *  system label; otherwise fall back to a generic heading. */
function systemLabel(names: string[]): string {
  if (names.length === 0) return 'Your hospitals';
  const firstWord = (n: string) => n.trim().split(/\s+/)[0] ?? '';
  const w = firstWord(names[0]!);
  return w && names.every((n) => firstWord(n) === w) ? w : 'Your hospitals';
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'positive' | 'warn' | 'bad' }) {
  const toneClass =
    tone === 'positive'
      ? 'text-cpcqc-teal-dark'
      : tone === 'warn'
        ? 'text-cpcqc-orange-dark'
        : tone === 'bad'
          ? 'text-cpcqc-pink-dark'
          : 'text-cpcqc-purple-dark';
  return (
    <div className="rounded-xl border border-cpcqc-purple-dark/10 bg-white p-3 shadow-sm">
      <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">{label}</div>
      <div className={`mt-1 font-rounded text-2xl font-extrabold ${toneClass}`}>{value}</div>
    </div>
  );
}

export default function SystemRollupPage() {
  const router = useRouter();
  const { hospitals, setActiveHospitalId } = useAuth();
  const [data, setData] = useState<SystemRollupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .get<SystemRollupResponse>('/me/rollup')
      .then((res) => !cancelled && setData(res))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const label = useMemo(() => systemLabel(hospitals.map((h) => h.name)), [hospitals]);

  // (hospitalId::initiativeId) → cell, for O(1) matrix lookup.
  const cellByKey = useMemo(() => {
    const m = new Map<string, RollupCell>();
    for (const c of data?.cells ?? []) m.set(`${c.hospitalId}::${c.initiativeId}`, c);
    return m;
  }, [data]);

  function drillTo(hospitalId: string) {
    setActiveHospitalId(hospitalId);
    router.push('/portal');
  }

  return (
    <div>
      <header className="mb-6">
        <p className="font-script text-2xl text-cpcqc-purple-dark/80">System view</p>
        <h1 className="inline-flex items-center gap-2 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark sm:text-4xl">
          <LayoutGrid size={28} aria-hidden /> {label} rollup
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Compliance across every hospital and initiative you have access to, for the current program
          year. Click any cell to open that hospital&rsquo;s dashboard.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          Couldn&rsquo;t load the rollup: {error}
        </div>
      )}

      {data === null && !error && (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading rollup…
        </div>
      )}

      {data && data.hospitals.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-card">
          <p className="font-rounded text-lg font-bold text-cpcqc-purple-dark">No enrollments to show yet.</p>
          <p className="mt-2 text-cpcqc-purple-dark/70">
            Once your hospitals are enrolled in an initiative, they&rsquo;ll appear here.
          </p>
        </div>
      )}

      {data && data.hospitals.length > 0 && (
        <>
          <div className="mb-6 grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Hospitals" value={data.totals.hospitals} />
            <Stat label="Enrollments" value={data.totals.enrollments} />
            <Stat label="Met" value={data.totals.met} tone="positive" />
            <Stat label="On track" value={data.totals.onTrack} />
            <Stat label="At risk" value={data.totals.atRisk} tone="warn" />
            <Stat label="Not met" value={data.totals.notMet} tone="bad" />
          </div>

          {/* Hospital × initiative matrix */}
          <div className="overflow-x-auto rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-cpcqc-cream/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                <tr>
                  <th className="sticky left-0 z-10 bg-cpcqc-cream/40 px-4 py-3">Hospital</th>
                  {data.initiatives.map((ini) => (
                    <th key={ini.id} className="px-4 py-3 text-center" title={ini.name}>
                      {ini.code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.hospitals.map((h) => (
                  <tr key={h.id} className="border-t border-cpcqc-purple-dark/10">
                    <td className="sticky left-0 z-10 bg-white px-4 py-3 font-semibold text-cpcqc-purple-dark">
                      {h.name}
                    </td>
                    {data.initiatives.map((ini) => {
                      const cell = cellByKey.get(`${h.id}::${ini.id}`);
                      if (!cell) {
                        return (
                          <td key={ini.id} className="px-4 py-3 text-center text-cpcqc-purple-dark/25">
                            —
                          </td>
                        );
                      }
                      return (
                        <td key={ini.id} className="px-4 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => drillTo(h.id)}
                            title={`Open ${h.name} · ${ini.name}`}
                            className="inline-flex flex-col items-center gap-1 rounded-lg px-2 py-1 hover:bg-cpcqc-purple/5"
                          >
                            {cell.overall ? (
                              <RequirementStatusPill status={cell.overall} />
                            ) : (
                              <span className="text-xs text-cpcqc-purple-dark/40">No data</span>
                            )}
                            {cell.track === 'sustainability' && (
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-cpcqc-purple-dark/50">
                                sustain
                              </span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Needs attention */}
          {data.needsAttention.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-3 inline-flex items-center gap-2 font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
                <AlertTriangle size={20} className="text-cpcqc-orange-dark" aria-hidden /> Needs attention
              </h2>
              <div className="space-y-2">
                {data.needsAttention.map((n) => (
                  <button
                    key={n.enrollmentId}
                    type="button"
                    onClick={() => drillTo(n.hospitalId)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-cpcqc-purple-dark/10 bg-white p-3 text-left shadow-sm hover:bg-cpcqc-purple/5"
                  >
                    <span className="font-semibold text-cpcqc-purple-dark">{n.hospitalName}</span>
                    <span className="rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
                      {n.initiativeCode}
                    </span>
                    {n.overall && <RequirementStatusPill status={n.overall} />}
                    <span className="text-sm text-cpcqc-purple-dark/70">
                      {n.failing.length > 0
                        ? n.failing
                            .map((f) => `${f.requirement} ${f.current}/${f.required}`)
                            .join(' · ')
                        : 'Behind on requirements'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
