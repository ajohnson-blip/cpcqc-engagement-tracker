'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function RootPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    router.replace(user.role.startsWith('cpcqc') ? '/staff' : '/portal');
  }, [user, loading, router]);

  return (
    <div className="grid min-h-screen place-items-center">
      <div className="font-rounded text-cpcqc-purple">Loading…</div>
    </div>
  );
}
