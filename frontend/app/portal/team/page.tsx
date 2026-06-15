'use client';

/**
 * Read-only champion roster for the hospital portal ("Team" tab). Hospitals
 * view their own roster grouped by initiative; CPCQC owns edits, so there's
 * no write path — corrections flow through the header's Report issue button.
 * Scoped to the active hospital (regional users switch via the header).
 */

import { useEffect, useMemo, useState } from 'react';
import { Mail, Phone, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type { MyRosterMember } from '@/lib/types';

const INITIATIVE_ORDER = ['TTT', 'SPARK', 'SOAR', 'NEST'] as const;

export default function PortalTeamPage() {
  const { activeHospitalId, hospitalName } = useAuth();
  const [roster, setRoster] = useState<MyRosterMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoster(null);
    api
      .get<{ roster: MyRosterMember[] }>(
        `/me/roster${activeHospitalId ? `?hospitalId=${activeHospitalId}` : ''}`,
      )
      .then((d) => !cancelled && setRoster(d.roster))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [activeHospitalId]);

  // Group by initiative, ordered TTT/SPARK/SOAR/NEST then unaffiliated last.
  const groups = useMemo(() => {
    if (!roster) return [];
    const byKey = new Map<
      string,
      { code: string | null; name: string; members: MyRosterMember[] }
    >();
    for (const m of roster) {
      const key = m.initiative?.code ?? '__none__';
      if (!byKey.has(key)) {
        byKey.set(key, {
          code: m.initiative?.code ?? null,
          name: m.initiative?.name ?? 'Other',
          members: [],
        });
      }
      byKey.get(key)!.members.push(m);
    }
    return Array.from(byKey.values()).sort((a, b) => {
      const ai = a.code ? INITIATIVE_ORDER.indexOf(a.code as (typeof INITIATIVE_ORDER)[number]) : 99;
      const bi = b.code ? INITIATIVE_ORDER.indexOf(b.code as (typeof INITIATIVE_ORDER)[number]) : 99;
      return ai - bi;
    });
  }, [roster]);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">Your team</h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          The champions {hospitalName ?? 'your hospital'} has on record with CPCQC, by initiative.
          See something out of date? Use <strong>Report issue</strong> (top right) and a CPCQC
          program manager will update it.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {roster === null && !error ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : roster && roster.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-card">
          No champions are on record yet. Reach out to CPCQC to get your team added.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div
              key={g.code ?? 'none'}
              className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5"
            >
              <div className="flex items-center gap-2 border-b border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/30 px-4 py-2.5">
                <Users size={15} className="text-cpcqc-purple" aria-hidden />
                <span className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
                  {g.code ? `${g.code} · ${g.name}` : 'Other'}
                </span>
                <span className="text-xs text-cpcqc-purple-dark/60">
                  {g.members.length} {g.members.length === 1 ? 'person' : 'people'}
                </span>
              </div>
              <table className="w-full text-left">
                <thead className="bg-cpcqc-cream-dark/20 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                  <tr>
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Role</th>
                    <th className="px-4 py-2">Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {g.members.map((m) => (
                    <tr key={m.id} className="border-t border-cpcqc-purple-dark/10">
                      <td className="px-4 py-2.5 font-semibold text-cpcqc-purple-dark">{m.name}</td>
                      <td className="px-4 py-2.5 text-sm text-cpcqc-purple-dark/80">
                        {m.role ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-sm">
                        {m.email && (
                          <a
                            href={`mailto:${m.email}`}
                            className="inline-flex items-center gap-1 text-cpcqc-purple hover:underline"
                          >
                            <Mail size={12} aria-hidden /> {m.email}
                          </a>
                        )}
                        {m.phone && (
                          <span className="ml-3 inline-flex items-center gap-1 text-cpcqc-purple-dark/80">
                            <Phone size={12} aria-hidden /> {m.phone}
                          </span>
                        )}
                        {!m.email && !m.phone && (
                          <span className="text-cpcqc-purple-dark/40">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
