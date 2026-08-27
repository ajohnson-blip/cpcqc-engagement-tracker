'use client';

/**
 * Staff view of step 2 — the legally mandated enrollment forms.
 *
 * The window is short (Nov 15 – Dec 1) and the question CPCQC asks throughout
 * it is not "what came in" but "who hasn't sent one yet". So the chase list
 * comes first and the submissions table second, rather than the other way
 * round: outstanding hospitals are the work, filed ones are the receipt.
 *
 * Read-only. Enrollment is the record that satisfies the statute — a
 * correction has to come from the hospital, through their own edit link, or
 * the distinction between what CPCQC was told and what CPCQC decided is gone.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Mail,
} from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import type {
  EnrollableInitiativeCode,
  EnrollmentCoverage,
  StaffEnrollmentForm,
  StaffEnrollmentOverview,
} from '@/lib/types';
import { fmtDate } from '@/lib/format';

const PROGRAM_YEAR = 2027;

const INITIATIVE_ORDER: EnrollableInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

const ROLE_LABEL: Record<string, string> = {
  nurse: 'Nurse champion',
  provider: 'Provider champion',
  data: 'Data champion',
  csuite: 'C-suite sponsor',
  other: 'Other champion',
};

type InitiativeFilter = EnrollableInitiativeCode | 'all';

export default function StaffEnrollmentFormsPage() {
  const [data, setData] = useState<StaffEnrollmentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<InitiativeFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StaffEnrollmentOverview>(`/staff/enrollment-forms?programYear=${PROGRAM_YEAR}`)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const forms = useMemo(() => {
    if (!data) return [];
    return filter === 'all'
      ? data.forms
      : data.forms.filter((f) => f.initiativeCode === filter);
  }, [data, filter]);

  async function downloadXlsx() {
    try {
      const res = await apiFetch(
        `/api/staff/enrollment-forms/export?programYear=${PROGRAM_YEAR}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cpcqc-${PROGRAM_YEAR}-enrollment-forms.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          Enrollment Forms
        </h1>
        <p className="mt-1 max-w-3xl text-cpcqc-purple-dark/70">
          Step two of {PROGRAM_YEAR} enrollment — the forms that satisfy the statute.
          Who owes one is worked out from the interest-form acceptances (and, for TtT,
          from the hospitals already in a cohort), so accepting a hospital for an
          initiative is what puts it on this list.
        </p>
        {data?.window.opensAt && data.window.closesAt && (
          <p className="mt-2 text-sm text-cpcqc-purple-dark/60">
            Window: {fmtDate(data.window.opensAt)} – {fmtDate(data.window.closesAt)}
          </p>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {!data ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {INITIATIVE_ORDER.map((code) => {
              const c = data.coverage.find((x) => x.initiativeCode === code);
              return c ? <CoverageCard key={code} coverage={c} /> : null;
            })}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Initiative
            </span>
            {(['all', ...INITIATIVE_ORDER] as InitiativeFilter[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setFilter(v)}
                className={clsx(
                  'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition',
                  filter === v
                    ? 'bg-cpcqc-purple text-white'
                    : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10',
                )}
              >
                {v === 'all' ? 'All' : v}
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

          {forms.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
              {data.forms.length === 0
                ? `No enrollment forms submitted yet for ${PROGRAM_YEAR}.`
                : `No ${filter} enrollment forms yet.`}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
              <table className="w-full text-left">
                <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                  <tr>
                    <th className="w-px px-4 py-3" />
                    <th className="px-4 py-3">Hospital</th>
                    <th className="px-4 py-3">Initiative</th>
                    <th className="px-4 py-3">Submitter</th>
                    <th className="px-4 py-3">EHR</th>
                    <th className="px-4 py-3">Champions</th>
                    <th className="px-4 py-3">Confirmed</th>
                    <th className="px-4 py-3">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {forms.map((f) => (
                    <FormRows
                      key={f.id}
                      form={f}
                      expanded={expandedId === f.id}
                      onToggle={() => setExpandedId(expandedId === f.id ? null : f.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One initiative's chase list.
 *
 * Names, not just a count: "3 outstanding" sends a PM to another screen to
 * find out which three, and in the last week of the window that round trip is
 * the difference between chasing them and not.
 */
function CoverageCard({ coverage }: { coverage: EnrollmentCoverage }) {
  const { initiativeCode, expected, submittedCount, outstanding, unexpectedCount } = coverage;
  const done = expected.length > 0 && outstanding.length === 0;

  return (
    <div
      className={clsx(
        'rounded-2xl bg-white p-4 shadow-card ring-1',
        done ? 'ring-cpcqc-teal-dark/30' : 'ring-cpcqc-purple-dark/5',
      )}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
          {initiativeCode}
        </h2>
        <span className="text-sm font-semibold text-cpcqc-purple-dark/70">
          {submittedCount} / {expected.length}
        </span>
      </div>

      {expected.length === 0 ? (
        <p className="mt-2 text-xs text-cpcqc-purple-dark/50">
          {initiativeCode === 'TTT'
            ? 'No hospitals continuing TtT this year.'
            : 'Nobody accepted for this initiative yet.'}
        </p>
      ) : done ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-cpcqc-teal-dark">
          <CheckCircle2 size={13} aria-hidden /> All expected forms received
        </p>
      ) : (
        <div className="mt-2">
          <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-orange-dark">
            <AlertTriangle size={12} aria-hidden /> {outstanding.length} outstanding
          </p>
          <ul className="mt-1.5 space-y-0.5 text-sm text-cpcqc-purple-dark/80">
            {outstanding.map((h) => (
              <li key={h.id}>{h.name}</li>
            ))}
          </ul>
        </div>
      )}

      {unexpectedCount > 0 && (
        <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
          + {unexpectedCount} filed by {unexpectedCount === 1 ? 'a hospital' : 'hospitals'} not
          on the accepted list
        </p>
      )}
    </div>
  );
}

function FormRows({
  form,
  expanded,
  onToggle,
}: {
  form: StaffEnrollmentForm;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ehr =
    form.ehr === 'Other…' && form.ehrOther ? `Other: ${form.ehrOther}` : (form.ehr ?? '—');

  return (
    <>
      <tr
        className={clsx(
          'cursor-pointer border-t border-cpcqc-purple-dark/10 hover:bg-cpcqc-cream-dark/15',
          expanded && 'bg-cpcqc-cream-dark/20',
        )}
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} details for ${form.hospital.name} ${form.initiativeCode}`}
            className="text-cpcqc-purple-dark/60"
          >
            {expanded ? (
              <ChevronDown size={16} aria-hidden />
            ) : (
              <ChevronRight size={16} aria-hidden />
            )}
          </button>
        </td>
        <td className="px-4 py-3 font-semibold text-cpcqc-purple-dark">
          {form.hospital.name}
        </td>
        <td className="px-4 py-3">
          <span className="inline-flex items-center rounded-full bg-cpcqc-purple/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
            {form.initiativeCode}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="text-sm text-cpcqc-purple-dark">{form.submitterName}</div>
          <div className="text-xs text-cpcqc-purple-dark/70">{form.submitterRole}</div>
        </td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">{ehr}</td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          {form.tttContinuationAttested && form.champions.length === 0 ? (
            <span className="italic text-cpcqc-purple-dark/60">attestation</span>
          ) : (
            form.champions.length
          )}
        </td>
        <td className="px-4 py-3">
          {form.verifiedAt ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-cpcqc-teal-dark">
              <CheckCircle2 size={12} aria-hidden /> {fmtDate(form.verifiedAt)}
            </span>
          ) : (
            // An unconfirmed form still occupies this hospital's slot for the
            // year, so it is worth a PM's attention rather than a blank cell.
            <span className="inline-flex items-center gap-1 rounded-full bg-cpcqc-orange-dark/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-orange-dark">
              <AlertTriangle size={10} aria-hidden /> Unconfirmed
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          {fmtDate(form.createdAt)}
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/10">
          <td colSpan={8} className="px-6 py-4">
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-cpcqc-purple-dark/80">
              <span>
                <strong className="text-cpcqc-purple-dark">Submitted by:</strong>{' '}
                {form.submitterName} ({form.submitterEmail})
              </span>
              <span>
                <strong className="text-cpcqc-purple-dark">Via:</strong>{' '}
                {form.submittedVia === 'portal' ? 'Portal login' : 'Public link'}
              </span>
              {form.updatedAt !== form.createdAt && (
                <span>
                  <strong className="text-cpcqc-purple-dark">Last edited:</strong>{' '}
                  {fmtDate(form.updatedAt)}
                </span>
              )}
            </div>

            {form.tttContinuationAttested && form.champions.length === 0 ? (
              <p className="text-sm text-cpcqc-purple-dark/80">
                TtT continuation attested. Champions carry over from the existing cohort,
                so no roster is collected on this form.
              </p>
            ) : form.champions.length === 0 ? (
              <p className="text-sm italic text-cpcqc-purple-dark/60">
                No champions listed.
              </p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                  <tr>
                    <th className="py-1.5 pr-4">Role</th>
                    <th className="py-1.5 pr-4">Name</th>
                    <th className="py-1.5 pr-4">Title</th>
                    <th className="py-1.5 pr-4">Email</th>
                    <th className="py-1.5 pr-4">Access requested</th>
                  </tr>
                </thead>
                <tbody>
                  {form.champions.map((c, i) => (
                    <tr key={`${c.email}-${c.role}-${i}`} className="align-top">
                      <td className="py-1.5 pr-4 text-cpcqc-purple-dark">
                        {ROLE_LABEL[c.role] ?? c.role}
                        {c.isPrimary && (
                          <span className="ml-1.5 rounded-full bg-cpcqc-purple/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cpcqc-purple">
                            Primary
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-4 font-semibold text-cpcqc-purple-dark">
                        {c.name}
                      </td>
                      <td className="py-1.5 pr-4 text-cpcqc-purple-dark/80">{c.title}</td>
                      <td className="py-1.5 pr-4">
                        <a
                          href={`mailto:${c.email}`}
                          className="inline-flex items-center gap-1 text-cpcqc-purple hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Mail size={11} aria-hidden /> {c.email}
                        </a>
                      </td>
                      <td className="py-1.5 pr-4 text-cpcqc-purple-dark/80">
                        {[c.redcapAccess && 'REDCap', c.dashboardAccess && 'Dashboard']
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
