'use client';

/**
 * Staff interest-forms triage page.
 *
 * One flow: the annual ranked interest form (one row per hospital × program
 * year). The Cohort Planning aggregate at the top is the at-a-glance lens
 * for sizing cohorts; the table below is the per-submission triage surface.
 *
 * The legacy per-initiative form was retired (the public /interest route
 * had zero submissions and didn't match the actual operational flow —
 * hospitals get onboarded by CPCQC staff, not via a public form).
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Download, AlertTriangle, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  AnnualInterestForm,
  CohortPlanningAggregate,
} from '@/lib/types';
import { fmtDate } from '@/lib/format';
import { AnnualInterestDetailModal } from '@/components/annual-interest-detail-modal';

export default function InterestFormsListPage() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          Interest Forms
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Review the 2027 ranked submissions — flip to <em>under review</em> as you start
          looking, then accept (with decided cohorts) or decline.
        </p>
      </header>

      <AnnualPanel />
    </div>
  );
}

// ============================================================================
// Annual ranking
// ============================================================================

type AnnualStatusFilter = AnnualInterestForm['status'] | 'all';

const ANNUAL_STATUSES: Array<{ value: AnnualStatusFilter; label: string }> = [
  { value: 'submitted', label: 'New' },
  { value: 'under_review', label: 'Under review' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'declined', label: 'Declined' },
  { value: 'all', label: 'All' },
];

const ANNUAL_STATUS_STYLE: Record<AnnualInterestForm['status'], string> = {
  submitted: 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark',
  under_review: 'bg-cpcqc-purple/15 text-cpcqc-purple',
  accepted: 'bg-cpcqc-teal-dark/15 text-cpcqc-teal-dark',
  declined: 'bg-cpcqc-pink-dark/15 text-cpcqc-pink-dark',
};

function AnnualPanel() {
  // Year picker hardcoded for now — could be a dropdown once there's >1 year
  // worth of submissions in the DB.
  const [programYear] = useState(2027);
  const [statusFilter, setStatusFilter] = useState<AnnualStatusFilter>('all');
  const [forms, setForms] = useState<AnnualInterestForm[] | null>(null);
  const [aggregate, setAggregate] = useState<CohortPlanningAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFormId, setOpenFormId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setForms(null);
    const qp = new URLSearchParams();
    qp.set('programYear', String(programYear));
    if (statusFilter !== 'all') qp.set('status', statusFilter);
    api
      .get<{ forms: AnnualInterestForm[] }>(`/staff/annual-interest-forms?${qp.toString()}`)
      .then((d) => !cancelled && setForms(d.forms))
      .catch((err: Error) => !cancelled && setError(err.message));
    api
      .get<{ aggregate: CohortPlanningAggregate }>(
        `/staff/annual-interest-forms/aggregate?programYear=${programYear}`,
      )
      .then((d) => !cancelled && setAggregate(d.aggregate))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [programYear, statusFilter]);

  function handleUpdated(updated: AnnualInterestForm) {
    setForms((prev) =>
      prev ? prev.map((f) => (f.id === updated.id ? updated : f)) : prev,
    );
    // Refresh aggregate since status may have changed.
    api
      .get<{ aggregate: CohortPlanningAggregate }>(
        `/staff/annual-interest-forms/aggregate?programYear=${programYear}`,
      )
      .then((d) => setAggregate(d.aggregate))
      .catch(() => {});
  }

  async function downloadXlsx() {
    // Same fetch+blob+anchor dance the existing reports page uses, since
    // download fetches need to attach the auth header.
    try {
      const res = await fetch(
        `/api/staff/annual-interest-forms/export?programYear=${programYear}`,
        { credentials: 'include' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cpcqc-${programYear}-interest-forms.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    }
  }

  const openForm = openFormId ? forms?.find((f) => f.id === openFormId) ?? null : null;

  return (
    <>
      {aggregate && <CohortPlanningCard aggregate={aggregate} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
          Status
        </span>
        {ANNUAL_STATUSES.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={clsx(
              'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition',
              statusFilter === f.value
                ? 'bg-cpcqc-purple text-white'
                : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10',
            )}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void downloadXlsx()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
        >
          <Download size={12} aria-hidden /> Export XLSX
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {!forms ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : forms.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
          No interest forms match this filter for {programYear}.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <table className="w-full text-left">
            <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              <tr>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Hospital</th>
                <th className="px-4 py-3">Rankings</th>
                <th className="px-4 py-3">Intent</th>
                <th className="px-4 py-3">Flags</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <tr
                  key={f.id}
                  className="border-t border-cpcqc-purple-dark/10 hover:bg-cpcqc-cream-dark/15"
                >
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                    {fmtDate(f.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-semibold text-cpcqc-purple-dark">
                      {f.hospital.name}
                    </div>
                    <div className="text-xs text-cpcqc-purple-dark/70">
                      {f.submitterName} · {f.submitterRole}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <RankBadges form={f} />
                  </td>
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark">
                    {f.intendedInitiativeCount === 0
                      ? <span className="italic text-cpcqc-purple-dark/60">none</span>
                      : `${f.intendedInitiativeCount} of 2`}
                  </td>
                  <td className="px-4 py-3">
                    <FlagPills form={f} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={clsx(
                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide',
                        ANNUAL_STATUS_STYLE[f.status],
                      )}
                    >
                      {f.status === 'submitted'
                        ? 'New'
                        : f.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setOpenFormId(f.id)}
                      className="inline-flex items-center gap-1 font-semibold text-cpcqc-purple hover:underline"
                    >
                      <Pencil size={12} aria-hidden /> Triage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openForm && (
        <AnnualInterestDetailModal
          form={openForm}
          onClose={() => setOpenFormId(null)}
          onUpdated={(u) => {
            handleUpdated(u);
            setOpenFormId(null);
          }}
        />
      )}
    </>
  );
}

function CohortPlanningCard({ aggregate }: { aggregate: CohortPlanningAggregate }) {
  return (
    <div className="mb-6 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <div className="border-b border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/30 px-5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-rounded text-base font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
            {aggregate.programYear} Cohort Planning
          </h2>
          <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
            {aggregate.totalSubmissions} submission{aggregate.totalSubmissions === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
        {aggregate.perInitiative.map((p) => (
          <div
            key={p.code}
            className="rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-purple/5 p-4"
          >
            <div className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
              {p.code}
            </div>
            <div className="mt-2 space-y-1 text-sm text-cpcqc-purple-dark/85">
              <RankRow label="#1 choice" count={p.rankCounts[1]} accent />
              <RankRow label="#2 choice" count={p.rankCounts[2]} />
              <RankRow label="#3 choice" count={p.rankCounts[3]} />
            </div>
            <div className="mt-3 border-t border-cpcqc-purple-dark/10 pt-2 text-xs uppercase tracking-wide text-cpcqc-purple-dark/60">
              {p.totalInterested} ranked total
            </div>
          </div>
        ))}
      </div>

      {/* 2026 context — independent of submissions. Visible from day one so
          PMs can plan around the TTT continuation pool even before the
          window opens. */}
      <div className="border-t border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/30 px-5 py-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-[0.1em] text-cpcqc-purple-dark/60">
          {aggregate.programYear - 1} context
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-cpcqc-purple-dark">
          <span className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
            {aggregate.cohortContext.tttContinuationCount}
          </span>
          <span>
            hospital{aggregate.cohortContext.tttContinuationCount === 1 ? '' : 's'} currently
            in TTT — continuing automatically into {aggregate.programYear}
          </span>
        </div>
      </div>

      {/* Submission funnel — populates as hospitals submit. Labels make
          explicit that these tiles are submission-derived, not absolute. */}
      <div className="border-t border-cpcqc-purple-dark/10 bg-white px-5 py-3">
        <div className="mb-2 text-xs font-bold uppercase tracking-[0.1em] text-cpcqc-purple-dark/60">
          Of submissions so far
        </div>
        <div className="grid grid-cols-2 gap-4 text-sm text-cpcqc-purple-dark sm:grid-cols-4">
          <IntentTile label="Intent: 0" count={aggregate.intent[0]} />
          <IntentTile label="Intent: 1" count={aggregate.intent[1]} />
          <IntentTile label="Intent: 2" count={aggregate.intent[2]} />
          <IntentTile
            label="From TTT hospitals"
            count={aggregate.currentlyTTTSubmissionCount}
          />
        </div>
      </div>
    </div>
  );
}

function RankRow({
  label,
  count,
  accent,
}: {
  label: string;
  count: number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className={accent ? 'font-bold text-cpcqc-purple-dark' : ''}>{label}</span>
      <span
        className={
          'font-rounded text-lg font-extrabold ' +
          (accent ? 'text-cpcqc-purple' : 'text-cpcqc-purple-dark')
        }
      >
        {count}
      </span>
    </div>
  );
}

function IntentTile({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-bold">{label}</span>
      <span className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
        {count}
      </span>
    </div>
  );
}

function RankBadges({ form }: { form: AnnualInterestForm }) {
  const byRank = [...form.rankedInitiatives].sort((a, b) => a.rank - b.rank);
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {byRank.map((r) => (
        <span
          key={r.code}
          className={
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide ' +
            (r.rank === 1
              ? 'bg-cpcqc-purple text-white'
              : r.rank === 2
                ? 'bg-cpcqc-purple/15 text-cpcqc-purple'
                : 'bg-cpcqc-purple-dark/10 text-cpcqc-purple-dark/70')
          }
        >
          <span className="font-rounded">{r.rank}</span>
          <span>{r.code}</span>
        </span>
      ))}
    </div>
  );
}

function FlagPills({ form }: { form: AnnualInterestForm }) {
  const flags: Array<{ label: string; color: string }> = [];
  if (form.flags.currentlyEnrolledInTTT) {
    flags.push({
      label: 'TTT continuation',
      color: 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark',
    });
  }
  if (form.staffNote && form.staffNote.trim()) {
    flags.push({
      label: 'PM note',
      color: 'bg-cpcqc-teal-dark/15 text-cpcqc-teal-dark',
    });
  }
  if (form.decidedInitiatives && form.decidedInitiatives.length > 0) {
    flags.push({
      label: `→ ${form.decidedInitiatives.join(', ')}`,
      color: 'bg-cpcqc-purple/15 text-cpcqc-purple',
    });
  }
  if (flags.length === 0) {
    return <span className="text-xs text-cpcqc-purple-dark/40">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f, i) => (
        <span
          key={i}
          className={clsx(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold uppercase tracking-wide',
            f.color,
          )}
        >
          {f.label === 'TTT continuation' && <AlertTriangle size={10} aria-hidden />}
          {f.label}
        </span>
      ))}
    </div>
  );
}

