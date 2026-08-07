'use client';

/**
 * Step 1 of self-service password reset: ask for the account's email.
 *
 * The success state is deliberately identical whether or not the address has an
 * account — the API behaves the same way, and saying "no such user" here would
 * turn this page into a way to enumerate who has a tracker login.
 */

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { Logo } from '@/components/logo';
import { api, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/auth/password-reset/request', { email });
      setSubmitted(true);
    } catch (err) {
      // Only genuine failures (rate limit, network, server) surface here.
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Please wait a little while and try again.'
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

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
          {submitted ? (
            <div className="text-center">
              <MailCheck className="mx-auto h-10 w-10 text-cpcqc-teal-dark" />
              <h1 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
                Check your email
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                If an account exists for <strong>{email}</strong>, we&apos;ve sent a link to reset
                the password. It expires in one hour.
              </p>
              <p className="mt-3 text-xs text-slate-500">
                Nothing arrived after a few minutes? Check your junk folder, or contact CPCQC at{' '}
                <a className="text-cpcqc-purple underline" href="mailto:qi@cpcqc.org">
                  qi@cpcqc.org
                </a>
                .
              </p>
              <Link
                href="/login"
                className="mt-5 inline-block text-sm font-semibold text-cpcqc-purple hover:underline"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <h1 className="font-rounded text-xl font-bold text-cpcqc-purple-dark">
                Forgot your password?
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Enter the email address you use to sign in and we&apos;ll send you a link to choose
                a new password.
              </p>

              <form onSubmit={onSubmit} className="mt-5 space-y-4">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-slate-600">Email</span>
                  <input
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="you@hospital.org"
                  />
                </label>

                {error && <p className="text-xs text-cpcqc-pink-dark">{error}</p>}

                <button
                  type="submit"
                  disabled={submitting || !email}
                  className="w-full rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-50"
                >
                  {submitting ? 'Sending…' : 'Send reset link'}
                </button>
              </form>

              <p className="mt-4 text-center text-sm">
                <Link href="/login" className="font-semibold text-cpcqc-purple hover:underline">
                  Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
