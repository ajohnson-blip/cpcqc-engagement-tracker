'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { X, CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

type Category = 'bug' | 'data_correction' | 'feature_request' | 'other';

const CATEGORY_LABEL: Record<Category, string> = {
  bug: 'Something is broken',
  data_correction: 'Data is incorrect',
  feature_request: 'Feature request',
  other: 'Other',
};

interface ReportIssueModalProps {
  onClose: () => void;
}

export function ReportIssueModal({ onClose }: ReportIssueModalProps) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<Category>('bug');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/issue-reports', { subject, body, category });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-issue-title"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 id="report-issue-title" className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            Report an issue or concern
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/10"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        {submitted ? (
          <div className="px-6 pb-6 pt-2">
            <div className="flex flex-col items-center gap-3 rounded-xl bg-cpcqc-cream-dark/40 p-6 text-center">
              <CheckCircle2 size={32} className="text-emerald-700" aria-hidden />
              <p className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
                Report submitted
              </p>
              <p className="max-w-md text-sm text-cpcqc-purple-dark/70">
                Thanks — a CPCQC engineer will follow up if more info is needed. You can
                close this dialog.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 rounded-full bg-cpcqc-purple px-5 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 px-6 pb-6 pt-4">
            <p className="text-sm text-cpcqc-purple-dark/70">
              Goes to qi@cpcqc.org and is logged for staff to triage. Your name and
              hospital are attached automatically.
            </p>

            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
                Category
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
                className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-sm"
              >
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
                Subject
              </span>
              <input
                type="text"
                required
                minLength={3}
                maxLength={200}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. SOAR dashboard shows wrong meeting count for Avista"
                className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
                Description
              </span>
              <textarea
                required
                rows={6}
                minLength={5}
                maxLength={10_000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="What were you trying to do? What did you see? Any details about the hospital, initiative, or specific data that's wrong help us triage."
                className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-sm"
              />
            </label>

            {error && (
              <p className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-full bg-cpcqc-purple px-5 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-60"
              >
                {submitting ? 'Sending…' : 'Submit report'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
