'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, bootstrapSession, login as apiLogin, logout as apiLogout } from './api';
import type { AuthUser, MeResponse } from './types';

interface HospitalRef {
  id: string;
  name: string;
}

interface AuthState {
  user: AuthUser | null;
  /** Name of the currently active hospital (regional users can switch). */
  hospitalName: string | null;
  /** Full accessible-hospital set. >1 entry → regional user; show a switcher. */
  hospitals: HospitalRef[];
  /** Currently active hospital id (drives portal data scoping). */
  activeHospitalId: string | null;
  setActiveHospitalId: (id: string) => void;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Persist the regional user's active-hospital choice across reloads. Validated
// against the accessible set on load, so a stale value (or a different user on
// the same browser) falls back to the primary.
const ACTIVE_HOSPITAL_KEY = 'cpcqc.activeHospitalId';

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hospitals, setHospitals] = useState<HospitalRef[]>([]);
  const [activeHospitalId, setActiveHospitalIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const hospitalName =
    hospitals.find((h) => h.id === activeHospitalId)?.name ?? null;

  const setActiveHospitalId = useCallback((id: string) => {
    setActiveHospitalIdState(id);
    try {
      window.localStorage.setItem(ACTIVE_HOSPITAL_KEY, id);
    } catch {
      // localStorage unavailable (private mode etc.) — in-memory only.
    }
  }, []);

  const fetchMe = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>('/auth/me');
      setUser({ userId: me.user.id, role: me.user.role, hospitalId: me.user.hospitalId });
      const list = me.hospitals ?? [];
      setHospitals(list);
      // Resolve the active hospital: a persisted choice if still valid, else
      // the primary, else the first accessible.
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(ACTIVE_HOSPITAL_KEY);
      } catch {
        stored = null;
      }
      const valid = (id: string | null) => !!id && list.some((h) => h.id === id);
      const next =
        (valid(stored) && stored) ||
        (valid(me.user.hospitalId) && me.user.hospitalId) ||
        list[0]?.id ||
        null;
      setActiveHospitalIdState(next);
    } catch {
      setUser(null);
      setHospitals([]);
      setActiveHospitalIdState(null);
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
    setHospitals([]);
    setActiveHospitalIdState(null);
    try {
      window.localStorage.removeItem(ACTIVE_HOSPITAL_KEY);
    } catch {
      // ignore
    }
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        hospitalName,
        hospitals,
        activeHospitalId,
        setActiveHospitalId,
        loading,
        signIn,
        signOut,
        refresh: fetchMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
