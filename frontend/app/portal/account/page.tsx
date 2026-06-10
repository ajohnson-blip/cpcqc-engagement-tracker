'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ChangePasswordForm } from '@/components/change-password-form';
import { useAuth } from '@/lib/auth-context';

export default function PortalAccountPage() {
  const { user, hospitalName } = useAuth();
  return (
    <div className="mx-auto max-w-xl">
      <Link
        href="/portal"
        className="mb-4 inline-flex items-center gap-1 text-sm text-cpcqc-purple hover:underline"
      >
        <ArrowLeft size={14} /> Back to portal
      </Link>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">Account</h1>
        <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
          {hospitalName ? (
            <>
              Signed in for <span className="font-semibold">{hospitalName}</span>
              {user?.role === 'hospital_admin' ? ' (admin)' : ''}.
            </>
          ) : (
            'Manage your account settings.'
          )}
        </p>
      </header>

      <section>
        <h2 className="mb-3 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
          Change password
        </h2>
        <ChangePasswordForm returnHref="/portal" />
      </section>
    </div>
  );
}
