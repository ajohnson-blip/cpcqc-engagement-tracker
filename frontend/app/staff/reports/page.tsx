'use client';

import { useEffect, useState } from 'react';
import { Download, FileText, FileSpreadsheet, Users, Copy, Check, Mail } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import type {
  InitiativeHospitalsResponse,
  ChampionContact,
  ChampionContactsResponse,
  CohortTag,
  EngagementResponse,
} from '@/lib/types';

const INITIATIVES = ['TTT', 'SPARK', 'SOAR', 'NEST'] as const;

// Earliest program year worth offering in the reports picker. No engagement
// backfill data exists for years before this, so a report for an earlier year
// would render an empty document. Lower this when prior-year backfill lands.
const EARLIEST_PROGRAM_YEAR = 2026;

interface HospitalLite {
  id: string;
  name: string;
}

export default function StaffReportsPage() {
  const currentYear = new Date().getUTCFullYear();
  const [programYear, setProgramYear] = useState(Math.max(currentYear, EARLIEST_PROGRAM_YEAR));
  const [hospitals, setHospitals] = useState<HospitalLite[]>([]);
  const [selectedHospitalId, setSelectedHospitalId] = useState<string>('');

  useEffect(() => {
    // Reuse the staff per-initiative endpoint to pull all hospitals once.
    // Faster path would be a dedicated /hospitals?fields=id,name list — fine for v1.
    void Promise.all(
      INITIATIVES.map((code) =>
        api.get<InitiativeHospitalsResponse>(`/staff/initiatives/${code}/hospitals`).catch(() => null),
      ),
    ).then((all) => {
      const seen = new Map<string, HospitalLite>();
      for (const resp of all) {
        if (!resp) continue;
        for (const row of resp.hospitals) {
          if (!seen.has(row.hospital.id)) {
            seen.set(row.hospital.id, { id: row.hospital.id, name: row.hospital.name });
          }
        }
      }
      const list = Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
      setHospitals(list);
      if (list.length > 0) setSelectedHospitalId(list[0]!.id);
    });
  }, []);

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">Reports</h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Generate CDPHE annual compliance reports as PDF (for distribution) or XLSX (for
          downstream analysis). Per-hospital and per-initiative variants are also available.
        </p>
      </header>

      <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-white p-1.5 shadow-sm ring-1 ring-cpcqc-purple-dark/10">
        <label className="px-3 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
          Program year
        </label>
        <select
          value={programYear}
          onChange={(e) => setProgramYear(parseInt(e.target.value, 10))}
          className="rounded-full border border-cpcqc-purple-dark/15 bg-white px-3 py-1.5 text-sm font-semibold text-cpcqc-purple-dark"
        >
          {[currentYear - 1, currentYear, currentYear + 1]
            .filter((y) => y >= EARLIEST_PROGRAM_YEAR)
            .map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
        </select>
      </div>

      <EngagementPanel programYear={programYear} />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <ReportCard
          title="Annual report"
          description="The full CDPHE annual compliance report — every hospital × every enrollment, with per-initiative and per-hospital summaries, the engagement-metrics sheet, and the methodology appendix."
          paths={[
            { format: 'xlsx', href: `/api/reports/annual?programYear=${programYear}&format=xlsx` },
            { format: 'pdf', href: `/api/reports/annual?programYear=${programYear}&format=pdf` },
          ]}
        />

        <ReportCard
          title="By initiative"
          description="Scoped to a single initiative — useful for cohort reviews or initiative-specific check-ins."
          extra={
            <div className="mt-3 flex flex-col gap-2">
              {INITIATIVES.map((code) => (
                <InitiativeButtonGroup key={code} code={code} year={programYear} />
              ))}
            </div>
          }
        />

        <ReportCard
          title="By hospital"
          description="A single-hospital deep dive showing every enrollment that hospital holds and the requirement scores for each."
          extra={
            <div className="mt-3 flex flex-col gap-2">
              <select
                value={selectedHospitalId}
                onChange={(e) => setSelectedHospitalId(e.target.value)}
                className="rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-sm"
              >
                {hospitals.length === 0 && <option>Loading…</option>}
                {hospitals.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <DownloadButton
                  format="xlsx"
                  href={`/api/reports/hospital/${selectedHospitalId}?programYear=${programYear}&format=xlsx`}
                  disabled={!selectedHospitalId}
                />
                <DownloadButton
                  format="pdf"
                  href={`/api/reports/hospital/${selectedHospitalId}?programYear=${programYear}&format=pdf`}
                  disabled={!selectedHospitalId}
                />
              </div>
            </div>
          }
        />
      </div>

      <ChampionContactsCard />

      <p className="mt-8 max-w-2xl text-xs text-cpcqc-purple-dark/60">
        Reports compile data from the engagement tracker on demand. For the legal end-of-year
        CDPHE submission, run after Dec 31 so every requirement is finalized as Met or Not Met.
      </p>
    </div>
  );
}

const CONTACT_INITIATIVES = ['all', 'TTT', 'SPARK', 'SOAR', 'NEST'] as const;
type ContactInitiative = (typeof CONTACT_INITIATIVES)[number];

function csvCell(v: string | null): string {
  const s = (v ?? '').replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function ChampionContactsCard() {
  const [initiative, setInitiative] = useState<ContactInitiative>('all');
  const [contacts, setContacts] = useState<ChampionContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContacts(null);
    setError(null);
    setCopied(false);
    const qp = initiative === 'all' ? '' : `?initiative=${initiative}`;
    api
      .get<ChampionContactsResponse>(`/reports/champion-contacts${qp}`)
      .then((d) => !cancelled && setContacts(d.contacts))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [initiative]);

  // De-duped, non-empty emails — what you'd paste into a To/BCC field.
  const emails = Array.from(
    new Set((contacts ?? []).map((c) => c.email?.trim()).filter((e): e is string => !!e).map((e) => e.toLowerCase())),
  );
  const withEmail = (contacts ?? []).filter((c) => c.email?.trim()).length;

  function downloadCsv() {
    if (!contacts) return;
    const header = ['Hospital', 'Region', 'Initiative', 'Name', 'Role', 'Email', 'Phone'];
    const lines = [
      header.join(','),
      ...contacts.map((c) =>
        [c.hospital, c.region, c.initiativeCode, c.name, c.role, c.email, c.phone]
          .map(csvCell)
          .join(','),
      ),
    ];
    // Prepend a BOM so Excel reads UTF-8 correctly.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cpcqc-champion-contacts-${initiative}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  async function copyEmails() {
    try {
      await navigator.clipboard.writeText(emails.join('; '));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard.');
    }
  }

  return (
    <section className="mt-10 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <div className="h-1 w-full bg-cpcqc-teal-dark" />
      <div className="p-5">
        <h2 className="inline-flex items-center gap-2 font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
          <Users size={18} aria-hidden /> Champion contacts
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-cpcqc-purple-dark/70">
          The champion roster as a contact list — for emailing a cohort or building a mail
          merge. Filter by initiative, then download a CSV or copy every email at once.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 rounded-full bg-cpcqc-cream/60 p-1 ring-1 ring-cpcqc-purple-dark/10">
            {CONTACT_INITIATIVES.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setInitiative(code)}
                className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide transition ${
                  initiative === code
                    ? 'bg-cpcqc-purple text-white'
                    : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10'
                }`}
              >
                {code === 'all' ? 'All' : code}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={!contacts || contacts.length === 0}
            onClick={downloadCsv}
            className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-purple/90 disabled:opacity-50"
          >
            <FileSpreadsheet size={14} aria-hidden /> CSV <Download size={14} aria-hidden />
          </button>
          <button
            type="button"
            disabled={emails.length === 0}
            onClick={() => void copyEmails()}
            className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
          >
            {copied ? <Check size={14} aria-hidden /> : <Mail size={14} aria-hidden />}
            {copied ? 'Copied' : `Copy ${emails.length} email${emails.length === 1 ? '' : 's'}`}
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
            {error}
          </div>
        )}

        {contacts === null && !error ? (
          <p className="mt-4 text-sm text-cpcqc-purple-dark/60">Loading…</p>
        ) : contacts && contacts.length === 0 ? (
          <p className="mt-4 text-sm text-cpcqc-purple-dark/60">
            No champions on the roster for this filter.
          </p>
        ) : contacts ? (
          <>
            <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-cpcqc-purple-dark/60">
              {contacts.length} contact{contacts.length === 1 ? '' : 's'} · {withEmail} with email
            </p>
            <div className="mt-2 max-h-96 overflow-auto rounded-xl border border-cpcqc-purple-dark/10">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-cpcqc-cream/60 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                  <tr>
                    <th className="px-3 py-2">Hospital</th>
                    <th className="px-3 py-2">Initiative</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Phone</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c, i) => (
                    <tr key={i} className="border-t border-cpcqc-purple-dark/10">
                      <td className="px-3 py-2 text-cpcqc-purple-dark/80">{c.hospital}</td>
                      <td className="px-3 py-2 text-cpcqc-purple-dark/80">{c.initiativeCode ?? '—'}</td>
                      <td className="px-3 py-2 font-semibold text-cpcqc-purple-dark">{c.name}</td>
                      <td className="px-3 py-2 text-cpcqc-purple-dark/80">{c.role ?? '—'}</td>
                      <td className="px-3 py-2">
                        {c.email ? (
                          <a href={`mailto:${c.email}`} className="text-cpcqc-purple hover:underline">
                            {c.email}
                          </a>
                        ) : (
                          <span className="text-cpcqc-pink-dark/70">missing</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-cpcqc-purple-dark/80">{c.phone ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function ReportCard({
  title,
  description,
  paths,
  extra,
}: {
  title: string;
  description: string;
  paths?: Array<{ format: 'xlsx' | 'pdf'; href: string }>;
  extra?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <div className="h-1 w-full bg-cpcqc-pink" />
      <div className="p-5">
        <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">{title}</h2>
        <p className="mt-1 text-sm text-cpcqc-purple-dark/70">{description}</p>
        {paths && (
          <div className="mt-4 flex gap-2">
            {paths.map((p) => (
              <DownloadButton key={p.format} format={p.format} href={p.href} />
            ))}
          </div>
        )}
        {extra}
      </div>
    </div>
  );
}

function InitiativeButtonGroup({ code, year }: { code: string; year: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-cpcqc-purple-dark/15 px-3 py-2">
      <span className="font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
        {code}
      </span>
      <div className="flex gap-1.5">
        <SmallDownload format="xlsx" href={`/api/reports/initiative/${code}?programYear=${year}&format=xlsx`} />
        <SmallDownload format="pdf" href={`/api/reports/initiative/${code}?programYear=${year}&format=pdf`} />
      </div>
    </div>
  );
}

function DownloadButton({
  format,
  href,
  disabled,
}: {
  format: 'xlsx' | 'pdf';
  href: string;
  disabled?: boolean;
}) {
  const Icon = format === 'xlsx' ? FileSpreadsheet : FileText;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => triggerDownload(href)}
      className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-purple/90 disabled:opacity-50"
    >
      <Icon size={14} aria-hidden />
      {format}
      <Download size={14} aria-hidden />
    </button>
  );
}

function SmallDownload({ format, href }: { format: 'xlsx' | 'pdf'; href: string }) {
  const Icon = format === 'xlsx' ? FileSpreadsheet : FileText;
  return (
    <button
      type="button"
      onClick={() => triggerDownload(href)}
      className="inline-flex items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple hover:text-white hover:border-cpcqc-purple"
    >
      <Icon size={12} aria-hidden />
      {format}
    </button>
  );
}

/**
 * Server returns binary with Content-Disposition: attachment. The auth header
 * has to be present so we use fetch + blob + simulated click rather than a
 * plain anchor.
 */
async function triggerDownload(url: string) {
  const res = await apiFetch(url);
  if (!res.ok) {
    alert(`Download failed (${res.status}). Check the server logs.`);
    return;
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] ?? 'report';
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}


/**
 * The five funder-facing engagement metrics, with the grant-report paragraph
 * ready to copy.
 *
 * These numbers get asked for by funders on their own schedule, and were
 * previously assembled by hand from several screens — which is how a figure
 * ends up in a grant report that no longer matches the tracker. The same
 * summary is written into the annual XLSX export.
 */
function EngagementPanel({ programYear }: { programYear: number }) {
  const [data, setData] = useState<EngagementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cohorts, setCohorts] = useState<CohortTag[]>([]);
  const [cohort, setCohort] = useState<string>('');

  useEffect(() => {
    // Cohorts are edited on the hospital page, so refetch alongside the
    // figures rather than caching a list that may be a grant cycle old.
    api
      .get<{ tags: CohortTag[] }>('/hospitals/tags')
      .then((d) => setCohorts(d.tags))
      .catch(() => setCohorts([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const qs = new URLSearchParams({ programYear: String(programYear) });
    if (cohort) qs.set('cohort', cohort);
    api
      .get<EngagementResponse>(`/reports/engagement?${qs.toString()}`)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [programYear, cohort]);

  async function copy() {
    if (!data) return;
    await navigator.clipboard.writeText(data.narrative);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pctText = (v: number | null) => (v === null ? 'n/a' : `${v}%`);

  return (
    <section className="mb-6 rounded-2xl bg-white p-5 shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
            Engagement metrics
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-cpcqc-purple-dark/70">
            The five metrics CPCQC reports to funders, as participation rates. Included as a
            sheet in the annual XLSX export.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cohorts.length > 0 && (
            <select
              value={cohort}
              onChange={(e) => setCohort(e.target.value)}
              className="rounded-full border border-cpcqc-purple-dark/15 bg-white px-3 py-1.5 text-xs font-semibold text-cpcqc-purple-dark"
              aria-label="Cohort"
            >
              <option value="">All hospitals</option>
              {cohorts.map((c) => (
                <option key={c.tag} value={c.tag}>
                  {c.tag} ({c.hospitals})
                </option>
              ))}
            </select>
          )}
          {data && (
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? 'Copied' : 'Copy paragraph'}
          </button>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-cpcqc-pink-dark">{error}</p>}
      {!data && !error && <p className="mt-3 text-sm text-cpcqc-purple-dark/60">Loading…</p>}

      {data && (
        <>
          <p className="mt-4 rounded-xl bg-cpcqc-cream-dark/30 px-4 py-3 text-sm leading-relaxed text-cpcqc-purple-dark">
            {data.narrative}
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                <tr>
                  <th className="py-1.5 pr-4">Metric</th>
                  <th className="py-1.5 pr-4">Rate</th>
                  <th className="py-1.5 pr-4">Basis</th>
                  <th className="py-1.5 pr-4">Incl. late</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.overall.metrics.map((m) => (
                  <tr key={m.key} className="border-t border-cpcqc-purple-dark/10">
                    <td className="py-1.5 pr-4 text-cpcqc-purple-dark">{m.label}</td>
                    <td className="py-1.5 pr-4 font-semibold text-cpcqc-purple-dark">
                      {pctText(m.rate)}
                    </td>
                    <td className="py-1.5 pr-4 text-cpcqc-purple-dark/60">
                      {m.timely} of {m.expected}
                      {m.late > 0 ? ` · ${m.late} late, excluded` : ''}
                    </td>
                    <td className="py-1.5 pr-4 text-cpcqc-purple-dark/50">
                      {m.late > 0 ? pctText(m.rateInclLate) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                <tr>
                  <th className="py-1.5 pr-4">Program</th>
                  <th className="py-1.5 pr-4">Hospitals</th>
                  {data.summary.overall.metrics.map((m) => (
                    <th key={m.key} className="py-1.5 pr-4">
                      {m.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.summary.byInitiative.map((scope) => (
                  <tr key={scope.initiativeCode} className="border-t border-cpcqc-purple-dark/10">
                    <td className="py-1.5 pr-4 font-semibold text-cpcqc-purple-dark">
                      {scope.initiativeCode}
                    </td>
                    <td className="py-1.5 pr-4 text-cpcqc-purple-dark/70">{scope.hospitals}</td>
                    {scope.metrics.map((m) => (
                      <td key={m.key} className="py-1.5 pr-4 text-cpcqc-purple-dark/80">
                        {pctText(m.rate)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 rounded-xl bg-cpcqc-purple/5 px-4 py-3">
            <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
              SB24-175 — engagement in at least one initiative
            </h3>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-cpcqc-purple-dark/80">
              <span>
                <strong className="text-cpcqc-purple-dark">
                  {data.summary.statutory.engagedInAtLeastOne} of {data.summary.statutory.hospitals}
                </strong>{' '}
                hospitals engaged in ≥1
              </span>
              <span>
                <strong className="text-cpcqc-purple-dark">
                  {data.summary.statutory.compliantInAtLeastOne}
                </strong>{' '}
                meeting or on track in ≥1
              </span>
              {data.summary.statutory.atRiskInAll > 0 && (
                <span className="text-cpcqc-orange-dark">
                  <strong>{data.summary.statutory.atRiskInAll}</strong> at risk across all
                </span>
              )}
              {data.summary.statutory.notEngaged > 0 && (
                <span className="text-cpcqc-pink-dark">
                  <strong>{data.summary.statutory.notEngaged}</strong> not enrolled in any
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-cpcqc-purple-dark/60">
              {data.summary.statutory.byInitiativeCount
                .map((b) => `${b.hospitals} in ${b.initiatives}`)
                .join(' · ')}{' '}
              initiative(s). The statute requires a minimum of one, so a hospital in four
              discharges the same duty as a hospital in one.
            </p>
          </div>

          <p className="mt-3 text-xs text-cpcqc-purple-dark/60">
            As of {data.summary.asOf}. A task counts once its deadline has passed or it is done.
            The reported rate counts only submissions that were timely <em>and</em> complete —
            late arrivals are excluded, as they do not meet the operational definition. Tasks
            recorded as missed or not submitted never count.
          </p>
        </>
      )}
    </section>
  );
}
