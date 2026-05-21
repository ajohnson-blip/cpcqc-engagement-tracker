'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { Logo } from './logo';
import { useAuth } from '@/lib/auth-context';

interface NavItem {
  href: string;
  label: string;
}

const HOSPITAL_NAV: NavItem[] = [
  { href: '/portal', label: 'Overview' },
  { href: '/portal/tasks', label: 'My Tasks' },
];

export function PortalHeader() {
  const pathname = usePathname();
  const { user, hospitalName, signOut } = useAuth();

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
        </nav>

        <div className="flex items-center gap-3 text-sm">
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
    </header>
  );
}
