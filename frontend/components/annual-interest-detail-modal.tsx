'use client';

/**
 * Staff-only modal for triaging a single annual interest form.
 *
 * Shows the full submission (rankings, reasoning, intent) plus an editable
 * PM-note field and a status dropdown with optional decided cohorts. Saves
 * via PATCH /staff/annual-interest-forms/:id and bubbles the updated row up
 * to the parent table.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type {
  AnnualInterestForm,
  RankableInitiativeCode,
} from '@/lib/types';
import { fmtDate } from '@/lib/format';

const RANKABLE_CODES: RankableInitiativeCode[] = ['SPARK', 'SOAR', 'NEST'];

interface Props {
  form: AnnualInterestForm;
  onClose: () => void;
  onUpdated: (updated: AnnualInterestForm) => void;
}

export function AnnualInterestDetailModal({ form, onClose, onUpdated }: Props) {
  const [staffNote, setStaffNote] = useState(form.staffNote ?? '');
  const [status, setStatus] = useState<AnnualInterestForm['status']>(form.status);
  const [decided, setDecided] = useState<RankableInitiativeCode[]>(
    form.decidedInitiatives ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function toggleDecided(code: RankableInitiativeCode) {
    setDecided((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const trimmed = staffNote.trim();
      const res = await api.patch<{ form: AnnualInterestForm }>(
        `/staff/annual-interest-forms/${form.id}`,
        {
          staffNote: trimmed === '' ? null : trimmed,
          status,
          // Only send decided when status is accepted/declined; clear otherwise.
          decidedInitiatives:
            status === 'accepted' || status === 'declined' ? decided : null,
        },
      );
      onUpdated(res.form);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const sortedRanks = [...form.rankedInitiatives].sort((a, b) => a.rank - b.rank);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
              {form.hospital.name}
            </h2>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
              {form.programYear} interest form · submitted {fmtDate(form.createdAt)}
              {form.updatedAt !== form.createdAt && (
                <> · updated {fmtDate(form.updatedAt)}</>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-5 px-6 pb-5 pt-4">
          {form.flags.currentlyEnrolledInTTT && (
            <div className="flex items-start gap-2 rounded-lg bg-cpcqc-orange-dark/15 px-3 py-2 text-sm text-cpcqc-orange-dark">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                <strong>Currently enrolled in TTT.</strong> This hospital's TTT
                continuation is automatic — separate TTT Enrollment Form gets sent on
                the close date.
              </span>
            </div>
          )}

          {/* Submitter */}
          <div className="rounded-xl border border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/20 p-4 text-sm">
            <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              Submitter
            </div>
            <div className="mt-1 text-cpcqc-purple-dark">
              <div className="font-semibold">{form.submitterName}</div>
              <div className="text-cpcqc-purple-dark/80">
                {form.submitterRole}
                {' · '}
                <a
                  href={`mailto:${form.submitterEmail}`}
                  className="text-cpcqc-purple hover:underline"
                >
                  {form.submitterEmail}
                </a>
              </div>
            </div>
          </div>

          {/* Intent + Rankings */}
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              Submitted
            </div>
            <div className="mt-2 rounded-xl border border-cpcqc-purple-dark/10 bg-white p-4 text-sm text-cpcqc-purple-dark">
              <p>
                <strong>Intent:</strong>{' '}
                {form.intendedInitiativeCount === 0
                  ? 'No additional initiatives requested'
                  : `${form.intendedInitiativeCount} initiative(s)`}
              </p>
              <ol className="mt-3 space-y-2">
                {sortedRanks.map((r) => (
                  <li key={r.code} className="rounded-lg bg-cpcqc-purple/5 p-2">
                    <div className="font-rounded font-bold text-cpcqc-purple-dark">
                      {r.rank}. {r.code}
                    </div>
                    {form.reasoning[r.code] && (
                      <p className="mt-1 text-cpcqc-purple-dark/80">
                        {form.reasoning[r.code]}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          </div>

          {/* PM note */}
          <label className="block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              PM notes
            </span>
            <textarea
              rows={3}
              value={staffNote}
              onChange={(e) => setStaffNote(e.target.value)}
              maxLength={5000}
              placeholder="Decision context, follow-up actions, anything for the next reviewer…"
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
            />
          </label>

          {/* Status */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                Status
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as AnnualInterestForm['status'])}
                className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm"
              >
                <option value="submitted">Submitted</option>
                <option value="under_review">Under review</option>
                <option value="accepted">Accepted</option>
                <option value="declined">Declined</option>
              </select>
            </label>
            {(status === 'accepted' || status === 'declined') && (
              <div>
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                  Decided cohorts
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {RANKABLE_CODES.map((code) => {
                    const on = decided.includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => toggleDecided(code)}
                        className={
                          'rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide transition ' +
                          (on
                            ? 'border-cpcqc-purple bg-cpcqc-purple text-white'
                            : 'border-cpcqc-purple-dark/20 text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5')
                        }
                      >
                        {on && <CheckCircle2 size={12} className="mr-1 inline" aria-hidden />}
                        {code}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
