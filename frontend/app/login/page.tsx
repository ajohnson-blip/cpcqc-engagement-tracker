'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/logo';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const { signIn, user } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      router.replace(user.role.startsWith('cpcqc') ? '/staff' : '/portal');
    }
  }, [user, router]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? 'Email or password is incorrect.' : err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
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
          <div className="rounded-b-2xl bg-white p-8 shadow-card">
            <h1 className="mb-1 font-rounded text-2xl font-bold text-cpcqc-purple-dark">
              Sign in
            </h1>
            <p className="mb-6 text-sm text-cpcqc-purple-dark/70">
              For CPCQC staff and enrolled hospitals.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
                  Email
                </span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-base focus:border-cpcqc-purple focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
                  Password
                </span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-base focus:border-cpcqc-purple focus:outline-none"
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
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-cpcqc-purple-dark/70">
              Need help? Email{' '}
              <a
                className="text-cpcqc-purple underline decoration-cpcqc-purple/40 underline-offset-2 hover:decoration-cpcqc-purple"
                href="mailto:qi@cpcqc.org"
              >
                qi@cpcqc.org
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
