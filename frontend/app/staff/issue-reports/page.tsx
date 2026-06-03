'use client';

import { useEffect, useState } from 'react';
import { Mail, MessageSquareWarning } from 'lucide-react';
import { api } from '@/lib/api';

interface IssueReport {
  id: string;
  reporterUserId: string | null;
  reporterEmail: string;
  reporterRole: string;
  reporterHospitalId: string | null;
  subject: string;
  body: string;
  category: 'bug' | 'data_correction' | 'feature_request' | 'other';
  status: 'open' | 'in_progress' | 'resolved';
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_LABEL: Record<IssueReport['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

const STATUS_COLOR: Record<IssueReport['status'], string> = {
  open: 'bg-cpcqc-pink-dark/15 text-cpcqc-pink-dark',
  in_progress: 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark',
  resolved: 'bg-emerald-100 text-emerald-700',
};

const CATEGORY_LABEL: Record<IssueReport['category'], string> = {
  bug: 'Bug',
  data_correction: 'Data',
  feature_request: 'Feature',
  other: 'Other',
};

export default function StaffIssueReportsPage() {
  const [reports, setReports] = useState<IssueReport[] | null>(null);
  const [filter, setFilter] = useState<'all' | IssueReport['status']>('open');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setReports(null);
    const qs = filter === 'all' ? '' : `?status=${filter}`;
    api
      .get<{ reports: IssueReport[] }>(`/issue-reports${qs}`)
      .then((res) => setReports(res.reports))
      .catch((err: Error) => setError(err.message));
  }, [filter]);

  async function updateStatus(id: string, status: IssueReport['status']) {
    setSavingId(id);
    setError(null);
    try {
      const res = await api.patch<{ report: IssueReport }>(`/issue-reports/${id}`, { status });
      setReports((prev) => prev?.map((r) => (r.id === id ? res.report : r)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  async function saveResolutionNote(id: string, note: string) {
    setSavingId(id);
    setError(null);
    try {
      const res = await api.patch<{ report: IssueReport }>(`/issue-reports/${id}`, {
        resolutionNote: note || null,
      });
      setReports((prev) => prev?.map((r) => (r.id === id ? res.report : r)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
            <MessageSquareWarning className="mr-2 inline -translate-y-0.5" size={28} aria-hidden />
            Issue reports
          </h1>
          <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
            Submitted via the &ldquo;Report issue&rdquo; button in the header. Also emailed to
            qi@cpcqc.org as they come in.
          </p>
        </div>
        <div className="inline-flex rounded-full border border-cpcqc-purple-dark/15 bg-white p-1 text-xs font-bold uppercase tracking-wide">
          {(['open', 'in_progress', 'resolved', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1.5 ${
                filter === f
                  ? 'bg-cpcqc-purple text-white'
                  : 'text-cpcqc-purple-dark/70 hover:text-cpcqc-purple-dark'
              }`}
            >
              {f === 'all' ? 'All' : STATUS_LABEL[f]}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-200">
          {error}
        </div>
      )}

      {reports === null ? (
        <p className="text-sm text-cpcqc-purple-dark/60">Loading…</p>
      ) : reports.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
          No reports {filter === 'all' ? '' : `with status "${STATUS_LABEL[filter]}"`} yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => {
            const expanded = expandedId === r.id;
            return (
              <li
                key={r.id}
                className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5"
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : r.id)}
                  className="flex w-full flex-wrap items-start gap-3 px-5 py-4 text-left hover:bg-cpcqc-purple-dark/[.02]"
                >
                  <span
                    className={`mt-0.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_COLOR[r.status]}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  <span className="rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cpcqc-purple">
                    {CATEGORY_LABEL[r.category]}
                  </span>
                  <span className="flex-1 font-semibold text-cpcqc-purple-dark">{r.subject}</span>
                  <span className="text-xs text-cpcqc-purple-dark/60">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </button>
                {expanded && (
                  <div className="border-t border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/30 px-5 py-4">
                    <div className="mb-3 text-xs text-cpcqc-purple-dark/70">
                      <Mail size={12} aria-hidden className="-translate-y-0.5 mr-1 inline" />
                      <a href={`mailto:${r.reporterEmail}`} className="text-cpcqc-purple hover:underline">
                        {r.reporterEmail}
                      </a>
                      <span className="ml-2">· {r.reporterRole}</span>
                    </div>
                    <pre className="mb-4 whitespace-pre-wrap rounded-lg bg-white p-3 text-sm text-cpcqc-purple-dark/90 ring-1 ring-cpcqc-purple-dark/10">
                      {r.body}
                    </pre>

                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-cpcqc-purple-dark/70">
                        Status
                      </span>
                      {(['open', 'in_progress', 'resolved'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => updateStatus(r.id, s)}
                          disabled={savingId === r.id || r.status === s}
                          className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${
                            r.status === s
                              ? STATUS_COLOR[s]
                              : 'border border-cpcqc-purple-dark/15 text-cpcqc-purple-dark/70 hover:bg-cpcqc-purple-dark/5'
                          }`}
                        >
                          {STATUS_LABEL[s]}
                        </button>
                      ))}
                    </div>

                    <label className="block">
                      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-cpcqc-purple-dark/70">
                        Resolution note (visible to staff only)
                      </span>
                      <textarea
                        rows={3}
                        defaultValue={r.resolutionNote ?? ''}
                        onBlur={(e) => {
                          const v = e.currentTarget.value;
                          if (v !== (r.resolutionNote ?? '')) {
                            void saveResolutionNote(r.id, v);
                          }
                        }}
                        placeholder="What did we do? Link to the PR or migration if relevant."
                        className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
