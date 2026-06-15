'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { MessageSquareWarning, Building2 } from 'lucide-react';
import { Logo } from './logo';
import { ReportIssueModal } from './report-issue-modal';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import type { EnrollmentWindowResponse } from '@/lib/types';

interface NavItem {
  href: string;
  label: string;
}

const HOSPITAL_NAV: NavItem[] = [
  { href: '/portal', label: 'Overview' },
  { href: '/portal/tasks', label: 'My Tasks' },
  { href: '/portal/team', label: 'Team' },
  { href: '/portal/requirements', label: 'Requirements' },
];

// The interest-form nav chip only appears while the window is OPEN — we don't
// surface the form before it's time for hospitals to act on it.
const INTEREST_PROGRAM_YEAR = 2027;
const INTEREST_NAV_HREF = `/portal/interest/${INTEREST_PROGRAM_YEAR}`;

export function PortalHeader() {
  const pathname = usePathname();
  const { user, hospitalName, hospitals, activeHospitalId, setActiveHospitalId, signOut } =
    useAuth();
  const [showReportIssue, setShowReportIssue] = useState(false);
  const [interestOpen, setInterestOpen] = useState(false);
  const multiHospital = hospitals.length > 1;

  // Show the interest chip only when the window is open. Quietly best-effort:
  // if the window can't be fetched, the chip just stays hidden.
  useEffect(() => {
    let cancelled = false;
    api
      .get<EnrollmentWindowResponse>(
        `/portal/annual-interest-forms/window?programYear=${INTEREST_PROGRAM_YEAR}`,
      )
      .then((w) => !cancelled && setInterestOpen(w.windowState === 'open'))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const interestActive =
    pathname === INTEREST_NAV_HREF || pathname.startsWith(INTEREST_NAV_HREF + '/');

  return (
    <header className="border-b border-cpcqc-purple-dark/10 bg-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/portal" className="flex items-center gap-3">
          <Logo size="sm" />
        </Link>

        <nav aria-label="Primary" className="hidden flex-1 items-center gap-1 md:flex">
          {HOSPITAL_NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            return (
              <Link
                key={item.href}
                href={item.href}
                className={clsx(
                  'rounded-full px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide transition',
                  active
                    ? 'bg-cpcqc-purple text-white'
                    : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
                )}
              >
                {item.label}
              </Link>
            );
          })}
          {interestOpen && (
            <Link
              href={INTEREST_NAV_HREF}
              className={clsx(
                'ml-2 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 font-rounded text-xs font-semibold uppercase tracking-wide transition',
                interestActive
                  ? 'border-cpcqc-purple bg-cpcqc-purple/10 text-cpcqc-purple-dark'
                  : 'border-cpcqc-purple-dark/20 text-cpcqc-purple-dark/80 hover:bg-cpcqc-purple-dark/5',
              )}
            >
              {INTEREST_PROGRAM_YEAR} Interest
            </Link>
          )}
        </nav>

        <div className="flex items-center gap-3 text-sm">
          {multiHospital && (
            <label className="hidden items-center gap-1.5 rounded-full border border-cpcqc-purple/30 bg-cpcqc-purple/5 px-3 py-1.5 sm:inline-flex">
              <Building2 size={14} className="shrink-0 text-cpcqc-purple" aria-hidden />
              <span className="sr-only">Active hospital</span>
              <select
                value={activeHospitalId ?? ''}
                onChange={(e) => setActiveHospitalId(e.target.value)}
                className="max-w-[12rem] cursor-pointer truncate bg-transparent text-xs font-bold text-cpcqc-purple-dark focus:outline-none"
                title="Switch hospital"
              >
                {hospitals.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => setShowReportIssue(true)}
            title="Report an issue or concern"
            className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
          >
            <MessageSquareWarning size={14} aria-hidden />
            <span className="hidden sm:inline">Report issue</span>
          </button>
          <div className="hidden text-right sm:block">
            <div className="font-semibold text-cpcqc-purple-dark">
              {multiHospital ? 'Regional access' : (hospitalName ?? user?.role)}
            </div>
            <div className="flex justify-end gap-3 text-xs text-cpcqc-purple-dark/70">
              <Link href="/portal/account" className="hover:text-cpcqc-purple">
                Account
              </Link>
              <button
                type="button"
                onClick={() => void signOut()}
                className="hover:text-cpcqc-purple"
              >
                Sign out
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 sm:hidden"
          >
            Sign out
          </button>
        </div>
      </div>
      {showReportIssue && <ReportIssueModal onClose={() => setShowReportIssue(false)} />}
    </header>
  );
}
