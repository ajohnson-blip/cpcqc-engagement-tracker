'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, bootstrapSession, login as apiLogin, logout as apiLogout } from './api';
import type { AuthUser, MeResponse } from './types';

interface AuthState {
  user: AuthUser | null;
  hospitalName: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hospitalName, setHospitalName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>('/auth/me');
      setUser({ userId: me.user.id, role: me.user.role, hospitalId: me.user.hospitalId });
      setHospitalName(me.hospital?.name ?? null);
    } catch {
      setUser(null);
      setHospitalName(null);
    }
  }, []);

  // On mount, try to restore session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await bootstrapSession();
      if (cancelled) return;
      if (ok) await fetchMe();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMe]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await apiLogin(email, password);
      setUser(result.user);
      await fetchMe();
      const dest = result.user.role.startsWith('cpcqc') ? '/staff' : '/portal';
      router.push(dest);
    },
    [fetchMe, router],
  );

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setHospitalName(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ user, hospitalName, loading, signIn, signOut, refresh: fetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}
