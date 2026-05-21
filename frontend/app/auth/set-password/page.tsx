'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { Logo } from '@/components/logo';
import { api, ApiError } from '@/lib/api';

function SetPasswordInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <CenteredCard>
        <AlertCircle className="mx-auto mb-4 text-cpcqc-pink-dark" size={48} aria-hidden />
        <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
          Missing reset link
        </h1>
        <p className="mt-3 text-cpcqc-purple-dark/80">
          This page should be opened from the link in your CPCQC welcome email. If the link is
          broken, contact{' '}
          <a className="text-cpcqc-purple underline" href="mailto:engagement@qi.cpcqc.org">
            engagement@qi.cpcqc.org
          </a>{' '}
          for a fresh one.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
        >
          Go to sign-in
        </Link>
      </CenteredCard>
    );
  }

  if (done) {
    return (
      <CenteredCard>
        <CheckCircle2 className="mx-auto mb-4 text-cpcqc-teal-dark" size={48} aria-hidden />
        <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
          Password set
        </h1>
        <p className="mt-3 text-cpcqc-purple-dark/80">
          Your password has been saved. You can now sign in with your email and the password you
          just chose.
        </p>
        <button
          type="button"
          onClick={() => router.push('/login')}
          className="mt-6 rounded-full bg-cpcqc-purple px-5 py-2 font-rounded font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
        >
          Sign in
        </button>
      </CenteredCard>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/password-reset/confirm', { token, newPassword: password });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 400
            ? 'This link has expired or already been used. Request a fresh one from engagement@qi.cpcqc.org.'
            : err.message,
        );
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CenteredCard>
      <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
        Set your password
      </h1>
      <p className="mt-2 text-cpcqc-purple-dark/80">
        Choose a password to finish setting up your account. After this, sign in with your email
        and the password below.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4 text-left">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
            New password
          </span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="set-input"
          />
          <span className="mt-1 block text-xs text-cpcqc-purple-dark/60">
            At least 12 characters.
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
            Confirm password
          </span>
          <input
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="set-input"
          />
        </label>

        {error && (
          <p
            className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark"
            role="alert"
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white shadow-sm transition hover:bg-cpcqc-purple/90 disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Set password'}
        </button>
      </form>

      <style jsx>{`
        :global(.set-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(106, 101, 135, 0.2);
          background-color: white;
          padding: 0.55rem 0.75rem;
          font-size: 1rem;
        }
        :global(.set-input:focus) {
          outline: none;
          border-color: #6b529b;
          box-shadow: 0 0 0 3px rgba(107, 82, 155, 0.15);
        }
      `}</style>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center">
          <Logo size="lg" />
          <p className="mt-3 font-rounded text-sm uppercase tracking-[0.15em] text-cpcqc-purple-dark">
            Engagement Tracker
          </p>
        </div>
        <div className="cpcqc-content-strip">
          <div className="rounded-b-2xl bg-white p-8 text-center shadow-card">{children}</div>
        </div>
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  // useSearchParams suspense boundary required by Next.js App Router.
  return (
    <Suspense
      fallback={
        <CenteredCard>
          <p className="font-rounded text-cpcqc-purple">Loading…</p>
        </CenteredCard>
      }
    >
      <SetPasswordInner />
    </Suspense>
  );
}
