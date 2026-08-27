'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { MessageSquareWarning } from 'lucide-react';
import { Logo } from './logo';
import { ReportIssueModal } from './report-issue-modal';
import { useAuth } from '@/lib/auth-context';

const INITIATIVE_CODES = ['TTT', 'SPARK', 'SOAR', 'NEST'] as const;
const INITIATIVE_EMOJI: Record<(typeof INITIATIVE_CODES)[number], string> = {
  TTT: '🌊',
  SPARK: '✨',
  SOAR: '🪁',
  NEST: '🐣',
};

export function StaffHeader() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [showReportIssue, setShowReportIssue] = useState(false);

  function activeMatch(href: string, exact = false): boolean {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <header className="border-b border-cpcqc-purple-dark/10 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/staff" className="flex items-center gap-3">
          <Logo size="sm" />
          <span className="hidden font-rounded text-xs font-bold uppercase tracking-[0.2em] text-cpcqc-purple-dark/70 sm:inline">
            Staff
          </span>
        </Link>

        <nav aria-label="Primary" className="flex flex-1 flex-wrap items-center justify-center gap-1">
          <Link
            href="/staff"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff', true)
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Overview
          </Link>
          {INITIATIVE_CODES.map((code) => (
            <Link
              key={code}
              href={`/staff/initiatives/${code}`}
              className={clsx(
                'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
                activeMatch(`/staff/initiatives/${code}`)
                  ? 'bg-cpcqc-purple text-white'
                  : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
              )}
            >
              <span aria-hidden className="mr-1">{INITIATIVE_EMOJI[code]}</span>
              {code}
            </Link>
          ))}
          <Link
            href="/staff/interest-forms"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/interest-forms')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Interest Forms
          </Link>
          <Link
            href="/staff/enrollment-forms"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/enrollment-forms')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Enrollment Forms
          </Link>
          <Link
            href="/staff/reports"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/reports')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Reports
          </Link>
          <Link
            href="/staff/imports"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/imports')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Imports
          </Link>
          <Link
            href="/staff/ce"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/ce')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            CE Certificates
          </Link>
          <Link
            href="/staff/issue-reports"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/issue-reports')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Issues
          </Link>
          <Link
            href="/staff/users"
            className={clsx(
              'rounded-full px-3 py-1.5 font-rounded text-xs font-bold uppercase tracking-wide transition',
              activeMatch('/staff/users')
                ? 'bg-cpcqc-purple text-white'
                : 'text-cpcqc-purple-dark hover:bg-cpcqc-purple/10',
            )}
          >
            Access
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
            <div className="font-semibold text-cpcqc-purple-dark">CPCQC Staff</div>
            <div className="flex justify-end gap-3 text-xs text-cpcqc-purple-dark/70">
              <Link href="/staff/account" className="hover:text-cpcqc-purple">
                Account
              </Link>
              <button
                type="button"
                onClick={() => void signOut()}
                className="hover:text-cpcqc-purple"
              >
                Sign out ({user?.role.replace('cpcqc_', '')})
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
