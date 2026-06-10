'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ArrowRight, X, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import type {
  AnnualInterestForm,
  EnrollmentWindowResponse,
  MyEnrollment,
} from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { EnrollmentCard } from '@/components/enrollment-card';

// Which program year's interest window the portal banner cares about. Could
// be derived from "the next year with a configured window" once we have
// multiple years on file; hardcoded for now.
const INTEREST_PROGRAM_YEAR = 2027;

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
  const [interestWindow, setInterestWindow] = useState<EnrollmentWindowResponse | null>(null);
  const [interestSubmission, setInterestSubmission] = useState<AnnualInterestForm | null>(null);
  // Per-tab dismissal of the interest banner — soft "I saw it" rather than a
  // persistent preference. The permanent nav chip is the persistent affordance.
  const [interestBannerDismissed, setInterestBannerDismissed] = useState(false);
  // Show the banner during the open window (big purple CTA) AND during the
  // pre-window phase (quieter "opens soon" pill) so hospitals know the form
  // is coming. Hidden after the close date.
  const interestState = interestWindow?.windowState;
  const showInterestBanner =
    (interestState === 'open' || interestState === 'before') &&
    !interestBannerDismissed;

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
    // Fetch window + current submission for the banner. Both are optional —
    // if either 404s (no window configured, no submission yet) we still
    // render the rest of the page; only the banner changes.
    api
      .get<EnrollmentWindowResponse>(
        `/portal/annual-interest-forms/window?programYear=${INTEREST_PROGRAM_YEAR}`,
      )
      .then((win) => !cancelled && setInterestWindow(win))
      .catch(() => {});
    api
      .get<{ form: AnnualInterestForm | null }>(
        `/portal/annual-interest-forms?programYear=${INTEREST_PROGRAM_YEAR}`,
      )
      .then((res) => !cancelled && setInterestSubmission(res.form))
      .catch(() => {});
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

      {showInterestBanner && interestWindow && interestState === 'before' && (
        // "Opens soon" variant — quiet teal pill. Hospital is signed in early;
        // we want to tell them the window is coming without nagging.
        <div className="mb-6 overflow-hidden rounded-2xl bg-cpcqc-cream-dark/30 shadow-sm ring-1 ring-cpcqc-purple-dark/10">
          <div className="flex items-start justify-between gap-4 p-5 sm:items-center">
            <div className="flex items-start gap-3 sm:items-center">
              <CalendarDays
                size={22}
                className="mt-0.5 shrink-0 text-cpcqc-orange-dark sm:mt-0"
                aria-hidden
              />
              <div>
                <div className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
                  {INTEREST_PROGRAM_YEAR} enrollment opens{' '}
                  {fmtBannerDate(interestWindow.window.opensAt)}
                </div>
                <div className="mt-0.5 text-sm text-cpcqc-purple-dark/75">
                  You can preview the interest form now; submissions accepted{' '}
                  {fmtBannerDate(interestWindow.window.opensAt)} through{' '}
                  {fmtBannerDate(interestWindow.window.closesAt)},{' '}
                  {interestWindow.window.closesAt.slice(0, 4)}.
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href={`/portal/interest/${INTEREST_PROGRAM_YEAR}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 bg-white px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-cream"
              >
                Preview form <ArrowRight size={14} aria-hidden />
              </Link>
              <button
                type="button"
                onClick={() => setInterestBannerDismissed(true)}
                aria-label="Dismiss"
                className="rounded-full p-1.5 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          </div>
        </div>
      )}

      {showInterestBanner && interestWindow && interestState === 'open' && (
        interestSubmission ? (
          // Already-submitted variant: lower-key teal card with an "Update" CTA.
          // No dismiss X — once submitted, the banner doubles as the hospital's
          // confirmation that we received their submission.
          <div className="mb-6 overflow-hidden rounded-2xl bg-cpcqc-teal-dark/10 shadow-card ring-1 ring-cpcqc-teal-dark/30">
            <div className="flex items-start justify-between gap-4 p-5 sm:items-center">
              <div className="flex items-start gap-3 sm:items-center">
                <CheckCircle2
                  size={22}
                  className="mt-0.5 shrink-0 text-cpcqc-teal-dark sm:mt-0"
                  aria-hidden
                />
                <div>
                  <div className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
                    {INTEREST_PROGRAM_YEAR} interest form submitted
                  </div>
                  <div className="mt-0.5 text-sm text-cpcqc-purple-dark/80">
                    You can update your submission until{' '}
                    {fmtBannerDate(interestWindow.window.closesAt)},{' '}
                    {interestWindow.window.closesAt.slice(0, 4)}.
                  </div>
                </div>
              </div>
              <Link
                href={`/portal/interest/${INTEREST_PROGRAM_YEAR}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 bg-white px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-cream"
              >
                View / update <ArrowRight size={14} aria-hidden />
              </Link>
            </div>
          </div>
        ) : (
          // Not-yet-submitted variant: prominent purple call to action.
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
                    Forms accepted through {fmtBannerDate(interestWindow.window.closesAt)},{' '}
                    {interestWindow.window.closesAt.slice(0, 4)}.
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={`/portal/interest/${INTEREST_PROGRAM_YEAR}`}
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
        )
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
