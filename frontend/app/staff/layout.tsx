'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { StaffHeader } from '@/components/staff-header';

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!user.role.startsWith('cpcqc')) {
      router.replace('/portal');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center font-rounded text-cpcqc-purple">
        Loading…
      </div>
    );
  }
  if (!user || !user.role.startsWith('cpcqc')) return null;

  return (
    <div className="min-h-screen bg-cpcqc-cream">
      <StaffHeader />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
