'use client';

/**
 * Staff page to manage multi-hospital (regional) access for hospital users.
 *
 * Search a hospital user, then grant/revoke additional hospitals beyond their
 * primary. The primary (users.hospital_id) is shown read-only; this tool
 * manages the user_hospitals grants. Changes take effect on the user's next
 * token refresh (≤15 min) or immediately on re-login.
 */

import { useEffect, useState } from 'react';
import { Search, Building2, X, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { StaffUserListItem, UserHospitalsResponse } from '@/lib/types';

export default function StaffUsersPage() {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<StaffUserListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageUser, setManageUser] = useState<StaffUserListItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      const qp = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      api
        .get<{ users: StaffUserListItem[] }>(`/staff/users${qp}`)
        .then((d) => !cancelled && setUsers(d.users))
        .catch((err: Error) => !cancelled && setError(err.message));
    }, 250); // debounce
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  function bumpAdditionalCount(userId: string, delta: number) {
    setUsers((prev) =>
      prev
        ? prev.map((u) =>
            u.id === userId
              ? { ...u, additionalCount: Math.max(0, u.additionalCount + delta) }
              : u,
          )
        : prev,
    );
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          User access
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Grant regional staff access to additional hospitals in their system. Search a
          hospital user, then add or remove hospitals beyond their primary.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-cpcqc-purple-dark/10">
        <Search size={16} className="text-cpcqc-purple-dark/50" aria-hidden />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full bg-transparent text-sm text-cpcqc-purple-dark focus:outline-none"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {!users ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
          No hospital users match.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <table className="w-full text-left">
            <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Primary hospital</th>
                <th className="px-4 py-3">Extra access</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-cpcqc-purple-dark/10">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-cpcqc-purple-dark">
                      {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                    </div>
                    <div className="text-xs text-cpcqc-purple-dark/70">{u.email}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                    {u.primaryHospital?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {u.additionalCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
                        <Building2 size={11} aria-hidden /> +{u.additionalCount}
                      </span>
                    ) : (
                      <span className="text-cpcqc-purple-dark/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setManageUser(u)}
                      className="font-semibold text-cpcqc-purple hover:underline"
                    >
                      Manage access →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manageUser && (
        <ManageAccessModal
          user={manageUser}
          onClose={() => setManageUser(null)}
          onChanged={(delta) => bumpAdditionalCount(manageUser.id, delta)}
        />
      )}
    </div>
  );
}

function ManageAccessModal({
  user,
  onClose,
  onChanged,
}: {
  user: StaffUserListItem;
  onClose: () => void;
  onChanged: (delta: number) => void;
}) {
  const [data, setData] = useState<UserHospitalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-hospital picker.
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerResults, setPickerResults] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const load = () =>
    api
      .get<UserHospitalsResponse>(`/staff/users/${user.id}/hospitals`)
      .then(setData)
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (!pickerSearch.trim()) {
        setPickerResults([]);
        return;
      }
      api
        .get<{ hospitals: Array<{ id: string; name: string }> }>(
          `/hospitals?search=${encodeURIComponent(pickerSearch.trim())}&limit=20`,
        )
        .then((d) => !cancelled && setPickerResults(d.hospitals))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pickerSearch]);

  async function grant(hospitalId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/staff/users/${user.id}/hospitals`, { hospitalId });
      setPickerSearch('');
      setPickerResults([]);
      await load();
      onChanged(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not grant access.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(hospitalId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.del(`/staff/users/${user.id}/hospitals/${hospitalId}`);
      await load();
      onChanged(-1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke access.');
    } finally {
      setBusy(false);
    }
  }

  const existingIds = new Set(
    [data?.primaryHospital?.id, ...(data?.additionalHospitals ?? []).map((h) => h.id)].filter(
      Boolean,
    ) as string[],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
              {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
            </h2>
            <p className="mt-0.5 text-sm text-cpcqc-purple-dark/70">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-5 pt-4">
          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </div>
          )}

          {/* Primary (read-only) */}
          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Primary hospital
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-cpcqc-cream-dark/30 px-3 py-2 text-sm text-cpcqc-purple-dark">
              <Building2 size={14} className="text-cpcqc-purple-dark/60" aria-hidden />
              {data?.primaryHospital?.name ?? '—'}
              <span className="ml-auto text-xs text-cpcqc-purple-dark/50">primary</span>
            </div>
          </div>

          {/* Additional grants */}
          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Additional hospitals
            </div>
            {data && data.additionalHospitals.length === 0 ? (
              <p className="rounded-lg border border-dashed border-cpcqc-purple-dark/20 px-3 py-2 text-sm italic text-cpcqc-purple-dark/50">
                None yet — add one below for regional access.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {data?.additionalHospitals.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-2 rounded-lg border border-cpcqc-purple-dark/15 px-3 py-2 text-sm text-cpcqc-purple-dark"
                  >
                    <Building2 size={14} className="text-cpcqc-purple" aria-hidden />
                    {h.name}
                    <button
                      type="button"
                      onClick={() => void revoke(h.id)}
                      disabled={busy}
                      className="ml-auto inline-flex items-center rounded-full p-1 text-cpcqc-purple-dark/50 hover:bg-cpcqc-pink-dark/10 hover:text-cpcqc-pink-dark disabled:opacity-40"
                      aria-label={`Remove ${h.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add picker */}
          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Add a hospital
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2">
              <Plus size={14} className="text-cpcqc-purple-dark/50" aria-hidden />
              <input
                type="text"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search hospitals to grant…"
                className="w-full bg-transparent text-sm text-cpcqc-purple-dark focus:outline-none"
              />
            </div>
            {pickerResults.length > 0 && (
              <ul className="mt-1 max-h-44 overflow-auto rounded-lg border border-cpcqc-purple-dark/15">
                {pickerResults.map((h) => {
                  const already = existingIds.has(h.id);
                  return (
                    <li key={h.id}>
                      <button
                        type="button"
                        disabled={already || busy}
                        onClick={() => void grant(h.id)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-cpcqc-purple-dark hover:bg-cpcqc-purple/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Building2 size={13} className="text-cpcqc-purple-dark/50" aria-hidden />
                        {h.name}
                        {already && (
                          <span className="ml-auto text-xs text-cpcqc-purple-dark/50">
                            already has access
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="text-xs text-cpcqc-purple-dark/60">
            Changes take effect the next time {user.firstName || 'the user'} signs in (or within
            ~15 minutes as their session refreshes).
          </p>
        </div>
      </div>
    </div>
  );
}
