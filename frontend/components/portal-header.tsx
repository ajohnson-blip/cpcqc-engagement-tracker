'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { MessageSquareWarning } from 'lucide-react';
import { Logo } from './logo';
import { ReportIssueModal } from './report-issue-modal';
import { useAuth } from '@/lib/auth-context';

interface NavItem {
  href: string;
  label: string;
}

const HOSPITAL_NAV: NavItem[] = [
  { href: '/portal', label: 'Overview' },
  { href: '/portal/tasks', label: 'My Tasks' },
];

// Year-round, lower-visual-weight chip for the annual interest form. The
// big purple banner on /portal handles attention during the open window;
// this chip is the always-available way for someone to get back to the
// form after dismissing the banner.
const INTEREST_PROGRAM_YEAR = 2027;
const INTEREST_NAV_HREF = '/interest/preview';

export function PortalHeader() {
  const pathname = usePathname();
  const { user, hospitalName, signOut } = useAuth();
  const [showReportIssue, setShowReportIssue] = useState(false);
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
        </nav>

        <div className="flex items-center gap-3 text-sm">
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
              {hospitalName ?? user?.role}
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className="text-xs text-cpcqc-purple-dark/70 hover:text-cpcqc-purple"
            >
              Sign out
            </button>
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
