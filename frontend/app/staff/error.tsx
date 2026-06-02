'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Per-segment error boundary for the staff dashboard. Catches uncaught render
 * errors in any /staff/* page (modals, components, etc.) and shows a readable
 * fallback with the message instead of Next's default "Application error: a
 * client-side exception has occurred" page, which hides what actually broke.
 */
export default function StaffError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log so the error is also visible in the browser console.
    // eslint-disable-next-line no-console
    console.error('[staff] uncaught error:', error);
  }, [error]);

  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-pink-dark/20">
        <div className="flex items-center gap-3">
          <AlertTriangle className="text-cpcqc-pink-dark" size={28} aria-hidden />
          <h1 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            Something broke on this page.
          </h1>
        </div>
        <p className="mt-3 text-sm text-cpcqc-purple-dark/80">
          {error.message || 'An unexpected error occurred while rendering the page.'}
        </p>
        {error.digest && (
          <p className="mt-1 text-xs text-cpcqc-purple-dark/50">Error ID: {error.digest}</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-cpcqc-purple px-5 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.assign('/staff')}
            className="rounded-full border border-cpcqc-purple-dark/15 px-5 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
          >
            Back to overview
          </button>
        </div>
        <p className="mt-4 text-xs text-cpcqc-purple-dark/60">
          The full stack trace is logged to the browser console (open DevTools). Sharing
          that with engineering is the fastest path to a fix.
        </p>
      </div>
    </div>
  );
}
