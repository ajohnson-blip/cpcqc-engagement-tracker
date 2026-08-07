'use client';

/**
 * Step 2 of self-service password reset: set a new password using the token
 * from the emailed link.
 *
 * The backend revokes every refresh token on success, so completing this signs
 * the account out everywhere — which is the point if the reset was prompted by
 * a suspected compromise. We say so rather than letting it surprise anyone.
 */

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { Logo } from '@/components/logo';
import { api, ApiError } from '@/lib/api';

/** Matches the backend's z.string().min(12) on newPassword. */
const MIN_PASSWORD_LENGTH = 12;

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit =
    !!token && password.length >= MIN_PASSWORD_LENGTH && password === confirm && !submitting;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/auth/password-reset/confirm', { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400
          ? 'This reset link is invalid or has expired. Request a new one to continue.'
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="text-center">
        <h1 className="font-rounded text-xl font-bold text-cpcqc-purple-dark">
          This link isn&apos;t valid
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          The reset link is missing its token. It may have been cut short by your email client —
          try copying the whole link, or request a new one.
        </p>
        <Link
          href="/forgot-password"
          className="mt-5 inline-block rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-cpcqc-teal-dark" />
        <h1 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
          Password updated
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          You&apos;ve been signed out on all devices. Sign in with your new password to continue.
        </p>
        <button
          onClick={() => router.push('/login')}
          className="mt-5 rounded-full bg-cpcqc-purple px-5 py-2 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark"
        >
          Go to sign in
        </button>
      </div>
    );
  }

  return (
    <>
      <h1 className="font-rounded text-xl font-bold text-cpcqc-purple-dark">
        Choose a new password
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        At least {MIN_PASSWORD_LENGTH} characters. A short phrase you&apos;ll remember works better
        than something complicated you won&apos;t.
      </p>

      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">New password</span>
          <input
            type="password"
            required
            autoFocus
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {tooShort && (
            <span className="mt-1 block text-xs text-cpcqc-orange-dark">
              {MIN_PASSWORD_LENGTH - password.length} more character
              {MIN_PASSWORD_LENGTH - password.length === 1 ? '' : 's'} needed.
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">Confirm password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {mismatch && (
            <span className="mt-1 block text-xs text-cpcqc-orange-dark">
              Passwords don&apos;t match.
            </span>
          )}
        </label>

        {error && <p className="text-xs text-cpcqc-pink-dark">{error}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-50"
        >
          {submitting ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <Logo size="lg" />
          <p className="mt-3 font-rounded text-sm uppercase tracking-[0.15em] text-cpcqc-purple-dark">
            Engagement Tracker
          </p>
        </div>
        <div className="cpcqc-content-strip">
          {/* useSearchParams needs a Suspense boundary for static prerendering. */}
          <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
            <ResetPasswordForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
