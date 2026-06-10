'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ArrowRight, X } from 'lucide-react';
import { api } from '@/lib/api';
import type { MyEnrollment } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { EnrollmentCard } from '@/components/enrollment-card';

// MOCK: 2027 annual interest window. When this ships for real, these dates
// come from a config row keyed by program year and "is the window open?" is a
// helper rather than this hardcoded `true`. The banner hides once closed.
const INTEREST_PROGRAM_YEAR = 2027;
const INTEREST_WINDOW = {
  opensAt: '2026-08-01',
  closesAt: '2026-09-30',
} as const;
const INTEREST_WINDOW_OPEN_MOCK = true;

function fmtBannerDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function PortalHomePage() {
  const { hospitalName } = useAuth();
  const [enrollments, setEnrollments] = useState<MyEnrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per-tab dismissal of the interest banner — soft "I saw it" rather than a
  // persistent preference. The permanent nav chip is the persistent affordance.
  const [interestBannerDismissed, setInterestBannerDismissed] = useState(false);
  const showInterestBanner = INTEREST_WINDOW_OPEN_MOCK && !interestBannerDismissed;

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ enrollments: MyEnrollment[] }>('/me/enrollments')
      .then((data) => {
        if (!cancelled) setEnrollments(data.enrollments);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <header className="mb-8">
        <p className="font-script text-2xl text-cpcqc-purple-dark/80">Welcome back,</p>
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark sm:text-4xl">
          {hospitalName ?? 'Your Hospital'}
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Track your progress against the perinatal QI mandate across every initiative you're
          enrolled in.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          Couldn't load your enrollments: {error}
        </div>
      )}

      {showInterestBanner && (
        <div className="mb-6 overflow-hidden rounded-2xl bg-cpcqc-purple shadow-card">
          <div className="flex items-start justify-between gap-4 p-5 text-white sm:items-center">
            <div className="flex items-start gap-3 sm:items-center">
              <CalendarDays size={24} className="mt-0.5 shrink-0 sm:mt-0" aria-hidden />
              <div>
                <div className="font-rounded text-base font-extrabold">
                  {INTEREST_PROGRAM_YEAR} enrollment is open
                </div>
                <div className="mt-0.5 text-sm text-white/85">
                  Express your interest in CPCQC initiatives for {INTEREST_PROGRAM_YEAR}.
                  Forms accepted through {fmtBannerDate(INTEREST_WINDOW.closesAt)},{' '}
                  {INTEREST_WINDOW.closesAt.slice(0, 4)}.
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/interest/preview"
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-cream"
              >
                Open form <ArrowRight size={14} aria-hidden />
              </Link>
              <button
                type="button"
                onClick={() => setInterestBannerDismissed(true)}
                aria-label="Dismiss"
                className="rounded-full p-1.5 text-white/80 hover:bg-white/10 hover:text-white"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          </div>
        </div>
      )}

      {enrollments === null && !error && (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading enrollments…
        </div>
      )}

      {enrollments && enrollments.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-card">
          <p className="font-rounded text-lg font-bold text-cpcqc-purple-dark">
            You're not enrolled in any initiatives yet.
          </p>
          <p className="mt-2 text-cpcqc-purple-dark/70">
            Once a CPCQC program manager approves your Interest Form, your initiative will appear
            here.
          </p>
        </div>
      )}

      <div className="space-y-6">
        {enrollments?.map((e) => (
          <EnrollmentCard key={e.enrollmentId} enrollment={e} />
        ))}
      </div>
    </div>
  );
}
