'use client';

/**
 * The end-of-year QI summary, offered in a year's Q4 1:1: a PDF of that
 * year's 1:1s, aims and PDSA tests, and call notes. It is built from what has
 * been saved, not from unsaved edits in the open window.
 */

import { useState } from 'react';
import { Download } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { TaskRow } from '@/lib/types';

/** The year a Q4 1:1 closes, or null for any other task. */
function summaryYearOf(task: TaskRow): number | null {
  const m = /^(\d{4})-Q4$/.exec(task.period);
  return task.template.taskType === 'qi_advising' && m ? Number(m[1]) : null;
}

export function QiSummaryDownload({ task }: { task: TaskRow }) {
  const year = summaryYearOf(task);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (year === null) return null;

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/tasks/enrollment/${task.enrollmentId}/qi-summary?year=${year}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Cross-origin, the browser may not show us the server's filename.
      const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = m?.[1] ?? `QI-summary-${year}.pdf`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    } catch {
      setError('Could not download the summary. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-cpcqc-teal/30 bg-cpcqc-teal/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-cpcqc-purple-dark">
          <strong>End-of-year QI summary.</strong> The {year} 1:1s, aims and PDSA tests, and call
          notes, as saved.
        </p>
        <button
          type="button"
          onClick={download}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-cpcqc-teal-dark px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-teal-dark/90 disabled:opacity-50"
        >
          <Download size={14} aria-hidden />
          {busy ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-cpcqc-pink-dark">{error}</p>}
    </div>
  );
}
