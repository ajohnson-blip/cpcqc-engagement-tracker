'use client';

/**
 * Bulk-accept dialog for the staff annual interest triage. Pick the cohort(s)
 * the selected hospitals are being accepted into, confirm, and the parent
 * fires POST /staff/annual-interest-forms/bulk-accept.
 *
 * Overwrite semantics: the chosen cohort set replaces each selected form's
 * decided cohorts. PMs group hospitals by their final assignment and run this
 * once per group (a hospital getting SPARK+NEST goes in the [SPARK, NEST]
 * batch). The dialog spells out the email side effect since this can notify
 * many hospitals at once.
 */

import { useState } from 'react';
import { X, CheckCircle2, AlertTriangle, Mail } from 'lucide-react';
import type { RankableInitiativeCode } from '@/lib/types';

const RANKABLE_CODES: RankableInitiativeCode[] = ['SPARK', 'SOAR', 'NEST'];

interface Props {
  hospitalNames: string[];
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (decidedInitiatives: RankableInitiativeCode[]) => void;
}

export function AnnualBulkAcceptDialog({
  hospitalNames,
  saving,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [decided, setDecided] = useState<RankableInitiativeCode[]>([]);
  const count = hospitalNames.length;

  function toggle(code: RankableInitiativeCode) {
    setDecided((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            Accept {count} hospital{count === 1 ? '' : 's'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark disabled:opacity-50"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 px-6 pb-5 pt-4">
          <div>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              Accept into which cohort(s)?
            </span>
            <div className="flex flex-wrap gap-2">
              {RANKABLE_CODES.map((code) => {
                const on = decided.includes(code);
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggle(code)}
                    className={
                      'rounded-full border px-4 py-1.5 text-sm font-bold uppercase tracking-wide transition ' +
                      (on
                        ? 'border-cpcqc-purple bg-cpcqc-purple text-white'
                        : 'border-cpcqc-purple-dark/20 text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5')
                    }
                  >
                    {on && <CheckCircle2 size={13} className="mr-1 inline" aria-hidden />}
                    {code}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
              This sets (replaces) the decided cohorts for every selected hospital.
            </p>
          </div>

          {/* Selected hospitals — capped preview so a 30-row batch doesn't
              blow out the dialog. */}
          <div className="rounded-xl border border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/20 p-3 text-sm text-cpcqc-purple-dark/80">
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Selected
            </div>
            <div className="max-h-24 overflow-auto leading-snug">
              {hospitalNames.slice(0, 12).join(', ')}
              {count > 12 ? `, +${count - 12} more` : ''}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-orange-dark">
            <Mail size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              This will email an acceptance notice to {count} hospital
              {count === 1 ? '' : 's'} (those not already accepted). Declines and
              status changes don't email — only acceptance does.
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(decided)}
              disabled={saving || decided.length === 0}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {saving
                ? 'Accepting…'
                : `Accept & notify ${count}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
