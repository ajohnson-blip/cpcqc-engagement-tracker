'use client';

/**
 * Landing page for the emailed confirmation link. Opening it is what makes a
 * public interest submission final — until then the row exists but is unverified.
 */

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';

interface VerifyResult {
  programYear: number;
  hospitalName: string;
  submitterName: string;
  alreadyVerified: boolean;
}

function Verifier() {
  const token = useSearchParams().get('token') ?? '';
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its token. It may have been cut short by your email client — try copying the whole link.');
      return;
    }
    api
      .post<VerifyResult>('/public/interest-forms/verify', { token })
      .then(setResult)
      .catch((e: Error) => setError(e.message));
  }, [token]);

  if (error) {
    return (
      <div className="text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-cpcqc-orange-dark" />
        <h1 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
          We couldn&rsquo;t confirm that link
        </h1>
        <p className="mt-2 text-sm text-cpcqc-purple-dark/80">{error}</p>
        <p className="mt-3 text-xs text-cpcqc-purple-dark/60">
          Need help? Contact <a className="underline" href="mailto:qi@cpcqc.org">qi@cpcqc.org</a>.
        </p>
      </div>
    );
  }

  if (!result) return <p className="text-center text-sm text-cpcqc-purple-dark/70">Confirming…</p>;

  return (
    <div className="text-center">
      <CheckCircle2 className="mx-auto h-10 w-10 text-cpcqc-teal-dark" />
      <h1 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
        {result.alreadyVerified ? 'Already confirmed' : 'Interest form confirmed'}
      </h1>
      <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
        Thank you, {result.submitterName}. {result.hospitalName}&rsquo;s {result.programYear}{' '}
        interest form has been received and will be reviewed by CPCQC staff.
      </p>
      <p className="mt-3 text-sm text-cpcqc-purple-dark/70">
        A program manager will be in touch with next steps, including the initiative-specific
        Enrollment Forms in November.
      </p>
      <p className="mt-4 text-sm text-cpcqc-purple-dark/75">
        Need to change something?{' '}
        <a className="underline" href={`/interest/${result.programYear}?token=${encodeURIComponent(token)}`}>
          Reopen your submission
        </a>{' '}
        — the same link is in your confirmation email.
      </p>
    </div>
  );
}

export default function VerifyInterestPage() {
  return (
    <div className="grid min-h-screen place-items-center bg-cpcqc-cream px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-card">
        {/* useSearchParams needs a Suspense boundary for static prerendering. */}
        <Suspense fallback={<p className="text-center text-sm text-cpcqc-purple-dark/70">Loading…</p>}>
          <Verifier />
        </Suspense>
      </div>
    </div>
  );
}
