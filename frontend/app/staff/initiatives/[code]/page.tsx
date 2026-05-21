'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import type { InitiativeHospitalsResponse } from '@/lib/types';
import { RequirementStatusPill } from '@/components/status-pill';

const TRACK_OPTIONS = [
  { value: '', label: 'All tracks' },
  { value: 'active', label: 'Active' },
  { value: 'sustainability', label: 'Sustainability' },
] as const;

const SORT_OPTIONS = [
  { value: 'compliance', label: 'By status (worst first)' },
  { value: 'name', label: 'Alphabetical' },
] as const;

export default function InitiativeHospitalsPage() {
  const params = useParams<{ code: string }>();
  const code = params.code.toUpperCase();
  const [data, setData] = useState<InitiativeHospitalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<'' | 'active' | 'sustainability'>('');
  const [sort, setSort] = useState<'compliance' | 'name'>('compliance');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (track) qs.set('track', track);
    qs.set('sort', sort);
    if (search.trim()) qs.set('search', search.trim());
    setData(null);
    api
      .get<InitiativeHospitalsResponse>(`/staff/initiatives/${code}/hospitals?${qs.toString()}`)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [code, track, sort, search]);

  const counts = useMemo(() => {
    if (!data) return null;
    const c = { met: 0, on_track: 0, at_risk: 0, not_met: 0 };
    for (const row of data.hospitals) {
      const s = row.compliance?.result.overall;
      if (s && s in c) c[s as keyof typeof c]++;
    }
    return c;
  }, [data]);

  return (
    <div>
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-sm font-semibold text-cpcqc-purple-dark/70 hover:text-cpcqc-purple"
        >
          ← Overview
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              {data?.initiative.emoji && (
                <span aria-hidden className="text-3xl">{data.initiative.emoji}</span>
              )}
              <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
                {data?.initiative.name ?? code}
              </h1>
            </div>
            {data && (
              <p className="mt-1 text-cpcqc-purple-dark/70">
                {data.hospitals.length} enrollment{data.hospitals.length === 1 ? '' : 's'}
                {counts && (
                  <>
                    {' '}— <span className="text-cpcqc-teal-dark">{counts.met} met</span>,{' '}
                    <span className="text-cpcqc-purple">{counts.on_track} on track</span>,{' '}
                    <span className="text-cpcqc-orange-dark">{counts.at_risk} at risk</span>,{' '}
                    <span className="text-cpcqc-pink-dark">{counts.not_met} not met</span>
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-12">
        <label className="relative sm:col-span-6">
          <Search
            size={16}
            aria-hidden
            className="absolute left-3 top-1/2 -translate-y-1/2 text-cpcqc-purple-dark/50"
          />
          <input
            type="search"
            placeholder="Search hospitals…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-full border border-cpcqc-purple-dark/15 bg-white py-2 pl-9 pr-3 text-sm shadow-sm focus:border-cpcqc-purple focus:outline-none"
          />
        </label>
        <select
          value={track}
          onChange={(e) => setTrack(e.target.value as typeof track)}
          className="rounded-full border border-cpcqc-purple-dark/15 bg-white px-3 py-2 text-sm font-semibold text-cpcqc-purple-dark shadow-sm sm:col-span-3"
        >
          {TRACK_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="rounded-full border border-cpcqc-purple-dark/15 bg-white px-3 py-2 text-sm font-semibold text-cpcqc-purple-dark shadow-sm sm:col-span-3"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {!data ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : data.hospitals.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
          No hospitals match your filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <table className="w-full text-left">
            <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              <tr>
                <th className="px-4 py-3">Hospital</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Cohort</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.hospitals.map((row) => (
                <tr key={row.enrollmentId} className="border-t border-cpcqc-purple-dark/10">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-cpcqc-purple-dark">{row.hospital.name}</div>
                    {row.hospital.region && (
                      <div className="text-xs text-cpcqc-purple-dark/60">{row.hospital.region}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {row.hospital.defaultContactName && (
                      <div className="text-cpcqc-purple-dark">{row.hospital.defaultContactName}</div>
                    )}
                    {row.hospital.defaultContactEmail && (
                      <a
                        href={`mailto:${row.hospital.defaultContactEmail}`}
                        className="text-xs text-cpcqc-purple hover:underline"
                      >
                        {row.hospital.defaultContactEmail}
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {row.cohort && (
                      <>
                        <div className="text-cpcqc-purple-dark/80">{row.cohort.label}</div>
                        {row.cohort.track === 'sustainability' && (
                          <span className="inline-flex items-center rounded-full bg-cpcqc-teal/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cpcqc-teal-dark">
                            Sustainability
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                    {row.currentStage?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {row.compliance ? (
                      <RequirementStatusPill status={row.compliance.result.overall} />
                    ) : (
                      <span className="text-xs text-cpcqc-purple-dark/50">No data</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/hospitals/${row.hospital.id}`}
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
    </div>
  );
}
